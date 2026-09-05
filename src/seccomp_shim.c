#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <string.h>
#include <sys/syscall.h>
#include <ucontext.h>
#include <unistd.h>

typedef int (*sigaction_fn)(int, const struct sigaction *, struct sigaction *);

static sigaction_fn real_sigaction;
static struct sigaction previous_sigsys;

static void install_sigsys_handler(void);

static void *install_handler_after_bun_startup(void *unused)
{
    (void)unused;
    struct timespec delay = { .tv_sec = 0, .tv_nsec = 200 * 1000 * 1000 };
    nanosleep(&delay, NULL);
    install_sigsys_handler();
    return NULL;
}

static void syscall_sigsys_handler(int signo, siginfo_t *info, void *context)
{
    if (signo == SIGSYS && info && info->si_code == SYS_SECCOMP) {
#if defined(__aarch64__)
        ucontext_t *uc = (ucontext_t *)context;
        uc->uc_mcontext.regs[0] = (unsigned long)-ENOSYS;
        return;
#else
        (void)context;
#endif
    }

    if (previous_sigsys.sa_flags & SA_SIGINFO) {
        if (previous_sigsys.sa_sigaction)
            previous_sigsys.sa_sigaction(signo, info, context);
        return;
    }

    if (previous_sigsys.sa_handler == SIG_IGN)
        return;
    if (previous_sigsys.sa_handler && previous_sigsys.sa_handler != SIG_DFL) {
        previous_sigsys.sa_handler(signo);
        return;
    }

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = SIG_DFL;
    real_sigaction(SIGSYS, &action, NULL);
    raise(SIGSYS);
}

static void install_sigsys_handler(void)
{
    if (!real_sigaction)
        real_sigaction = (sigaction_fn)dlsym(RTLD_NEXT, "sigaction");
    if (!real_sigaction)
        return;

    struct sigaction action;
    memset(&action, 0, sizeof(action));
    sigemptyset(&action.sa_mask);
    action.sa_sigaction = syscall_sigsys_handler;
    action.sa_flags = SA_SIGINFO | SA_RESTART;
    real_sigaction(SIGSYS, &action, &previous_sigsys);
}

__attribute__((constructor)) static void preload_sigsys_init(void)
{
    install_sigsys_handler();
    pthread_t thread;
    if (pthread_create(&thread, NULL, install_handler_after_bun_startup, NULL) == 0)
        pthread_detach(thread);
}

int sigaction(int signo, const struct sigaction *action, struct sigaction *old_action)
{
    if (!real_sigaction)
        real_sigaction = (sigaction_fn)dlsym(RTLD_NEXT, "sigaction");
    if (!real_sigaction) {
        errno = ENOSYS;
        return -1;
    }

    if (signo == SIGSYS && action) {
        if (old_action) {
            memset(old_action, 0, sizeof(*old_action));
            old_action->sa_sigaction = syscall_sigsys_handler;
            old_action->sa_flags = SA_SIGINFO | SA_RESTART;
            sigemptyset(&old_action->sa_mask);
        }
        return 0;
    }

    return real_sigaction(signo, action, old_action);
}
