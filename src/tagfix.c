/*
 * libtagfix.so - disables Android bionic's heap pointer tagging.
 *
 * Why this exists
 * ---------------
 * Android 11+ bionic tags heap pointers using the ARM Top Byte Ignore (TBI)
 * feature: allocated pointers come back with a non-zero tag in bits 56-63.
 *
 * Bun (and JavaScriptCore inside it) NaN-boxes JavaScript values, storing a
 * pointer inside a double's payload. That round-trip clears the tag bits. When
 * such a pointer is later passed to free(), bionic verifies the tag, sees it
 * does not match, and aborts:
 *
 *   Fatal signal 6 (SIGABRT)
 *   "Pointer tag for 0xb400xxxxxxxxxxxx was truncated, expected 0x4"
 *
 * The fix is to turn heap tagging off before JSC initialises and starts
 * allocating, via mallopt(M_BIONIC_SET_HEAP_TAGGING_LEVEL, M_HEAP_TAGGING_LEVEL_NONE).
 *
 * This has to run as early as possible in the process, which is why it lives in
 * a preloaded library with a constructor - by the time main() runs, JSC has
 * already allocated memory.
 *
 * Complementary to libseccomp_shim.so, which fixes a different Android crash
 * (seccomp SIGSYS kills, notably on Android 10). Both are preloaded together by
 * the opencode wrapper.
 */

/*
 * bionic declares mallopt() behind an API-level availability guard, so it can be
 * invisible when compiling against an older API level than the device actually
 * runs. Declare it directly: we only need the symbol, and if the platform's
 * allocator does not implement this option mallopt() simply fails, which is the
 * status quo rather than a regression.
 */
extern int mallopt(int option, int value);

/* bionic: change the heap tagging state (scudo only; may be called any time). */
#ifndef M_BIONIC_SET_HEAP_TAGGING_LEVEL
#define M_BIONIC_SET_HEAP_TAGGING_LEVEL (-204)
#endif

/* Values for M_BIONIC_SET_HEAP_TAGGING_LEVEL (bionic's enum HeapTaggingLevel). */
#define M_HEAP_TAGGING_LEVEL_NONE (0)

/*
 * Constructor: runs at process start for a preloaded library, before the real
 * binary's entry point.
 */
__attribute__((constructor)) static void disable_heap_tagging(void)
{
    mallopt(M_BIONIC_SET_HEAP_TAGGING_LEVEL, M_HEAP_TAGGING_LEVEL_NONE);
}
