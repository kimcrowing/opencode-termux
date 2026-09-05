import net from "node:net";
import tls from "node:tls";

// Minimal forward CONNECT proxy that re-shapes the UPSTREAM TLS ClientHello to
// mimic Chrome-on-Windows, so the target WAF (瑞数 JA3 inspection) sees a
// real-browser TLS fingerprint instead of Chromium/BoringSSL on Linux.
// Chromium -> proxy: plain HTTP CONNECT (loopback, not inspected by WAF).
// proxy -> target: tls.connect with Chrome-like params.
const LISTEN = Number(process.env.WAF_PROXY_PORT || 8899);

// Chrome 151 (Windows) cipher preference order (subset, influence JA3).
const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AIS128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const CHROME_SIGALGS = [
  "ecdsa_secp256r1_sha256",
  "ecdsa_secp384r1_sha384",
  "ecdsa_secp521r1_sha512",
  "ed25519",
  "ed448",
  "rsa_pss_pss_sha256",
  "rsa_pss_pss_sha384",
  "rsa_pss_pss_sha512",
  "rsa_pss_rsae_sha256",
  "rsa_pss_rsae_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha256",
  "rsa_pkcs1_sha384",
  "rsa_pkcs1_sha512",
  "ECDSA-SHA256",
  "ECDSA-SHA384",
  "ECDSA-SHA512",
  "SHA256+RSA",
  "SHA384+RSA",
  "SHA512+RSA",
].join(":");

function shapedConnect(host, port, cb) {
  const sock = tls.connect(
    Number(port) || 443,
    host,
    {
      ALPNProtocols: ["h2", "http/1.1"],
      ciphers: CHROME_CIPHERS,
      sigalgs: CHROME_SIGALGS,
      groups: "x25519:secp256r1:secp384r1:ffdhe2048:ffdhe3072",
      honorCipherOrder: false,
      rejectUnauthorized: false,
      servername: host,
    },
    cb
  );
  return sock;
}

const server = net.createServer((client) => {
  client.once("data", (chunk) => {
    const headerEnd = chunk.indexOf("\r\n\r\n");
    if (headerEnd < 0) { client.destroy(); return; }
    const head = chunk.slice(0, headerEnd).toString("latin1");
    const firstLine = head.split("\r\n")[0];
    const m = firstLine.match(/^CONNECT\s+(\S+)\s*/i);
    if (!m) {
      // plain HTTP proxy request (rare for https targets)
      client.end("HTTP/1.1 405 Not Supported\r\n\r\n");
      return;
    }
    const target = m[1];
    const [host, port] = target.split(":");
    const rest = chunk.slice(headerEnd + 4);
    // Build a shaped TLS tunnel straight to the target.
    const tlsSock = shapedConnect(host, Number(port) || 443, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) tlsSock.write(rest);
      tlsSock.pipe(client);
      client.pipe(tlsSock);
    });
    tlsSock.on("error", () => client.destroy());
    client.on("error", () => tlsSock.destroy());
  });
  client.on("error", () => {});
});

server.listen(LISTEN, "127.0.0.1", () => {
  console.log("waf_proxy listening on 127.0.0.1:" + LISTEN);
});
