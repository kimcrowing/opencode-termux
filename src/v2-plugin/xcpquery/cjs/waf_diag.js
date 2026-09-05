'use strict';
/*
 * Browserless CNIPA cpquery 412-WAF token generator.
 *
 * Runs the site's obfuscated waf.js inside a Node vm with a minimal DOM/BOM
 * shim, drives its anti-bot challenge to completion, and returns the
 * verification cookie(s) it would set.  Fully headless — no browser engine.
 *
 * computeCookie(cd, nsd) -> Promise<string>
 *   resolves with a clean Cookie header value, e.g.
 *   "enable_dX1xbeXXXX=true; dX1xbeXXXX=<token>"
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const WAF_JS = path.join(__dirname, 'waf.js');

function makeCtx() {
  const noop = function () {};
  return {
    canvas: null, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '10px sans-serif',
    textAlign: 'left', globalAlpha: 1, globalCompositeOperation: 'source-over', lineCap: 'butt',
    lineJoin: 'miter', shadowBlur: 0, shadowColor: '', shadowOffsetX: 0, shadowOffsetY: 0,
    fillRect: noop, clearRect: noop, strokeRect: noop, fillText: noop, strokeText: noop,
    measureText() { return { width: 10 }; }, beginPath: noop, closePath: noop, moveTo: noop,
    lineTo: noop, arc: noop, bezierCurveTo: noop, quadraticCurveTo: noop, stroke: noop, fill: noop,
    clip: noop, rect: noop, save: noop, restore: noop, translate: noop, rotate: noop, scale: noop,
    transform: noop, setTransform: noop, setLineDash: noop,
    createLinearGradient() { return { addColorStop: noop }; },
    createRadialGradient() { return { addColorStop: noop }; }, drawImage: noop,
    getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }; },
    putImageData: noop, createImageData(w, h) { return { data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }; }
  };
}
function makeCanvas() {
  return { width: 300, height: 150, style: {}, getContext() { return makeCtx(); }, toDataURL() { return 'data:image/png;base64,'; } };
}

function wrapCalls(code) {
  return code
    .replace(/new\s+_\$mT\[_\$ne\]\s*\(/g, 'new _$brls_invoke_$(_$mT,_$ne)(')
    .replace(/_\$mT\[_\$ne\]\s*\(/g, '_$brls_invoke_$(_$mT,_$ne)(');
}

function buildSandbox() {
  const captured = { cookies: [], logs: [] };
  const sandbox = {};

  sandbox.console = {
    log: (...a) => { captured.logs.push(a.join(' ')); },
    warn: () => {}, error: (...a) => { captured.logs.push('ERR ' + a.join(' ')); }, debug: () => {}
  };
  // Run injected timeouts synchronously (bounded) so the decoder's async steps
  // complete deterministically inside the vm.
  let budget = 20000;
  sandbox.setTimeout = function (fn) { if (typeof fn === 'function' && budget-- > 0) { try { fn(); } catch (e) { captured.logs.push('SETTIMEOUT_ERR ' + e.message); } } return 0; };
  sandbox.clearTimeout = function () {};
  sandbox.setInterval = function () { return 0; };
  sandbox.clearInterval = function () {};
  sandbox.requestAnimationFrame = function (fn) { if (budget-- > 0) { try { fn(); } catch (e) {} } return 0; };
  sandbox.cancelAnimationFrame = function () {};
  sandbox.performance = { now: () => Number(process.hrtime.bigint()) / 1e6 };

  const natives = ['Date', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'RegExp', 'Boolean',
    'Error', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'ArrayBuffer', 'Uint8Array', 'Uint8ClampedArray',
    'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
    'DataView', 'TextEncoder', 'TextDecoder', 'Promise', 'Proxy', 'Reflect', 'parseInt', 'parseFloat', 'isNaN',
    'decodeURIComponent', 'encodeURIComponent'];
  natives.forEach(n => { sandbox[n] = global[n]; });
  sandbox.atob = (s) => { try { return Buffer.from(String(s), 'base64').toString('binary'); } catch (e) { return ''; } };
  sandbox.btoa = (s) => Buffer.from(String(s), 'binary').toString('base64');
  sandbox.escape = escape; sandbox.unescape = unescape;
  sandbox.Blob = function () {};
  sandbox.URL = { createObjectURL() { return 'blob:'; }, revokeObjectURL() {} };
  sandbox.WebSocket = function () {};
  sandbox.crypto = crypto.webcrypto;
  sandbox.Event = function () {};
  sandbox.CustomEvent = function () {};
  sandbox.Image = function () {
    const el = { width: 0, height: 0, complete: true,
      set src(v) { if (el.onload) el.onload({ type: 'load' }); },
      addEventListener(t, fn) { if (t === 'load') el.onload = fn; } };
    return el;
  };
  sandbox.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  sandbox.sessionStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };

  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.top = sandbox; sandbox.parent = sandbox; sandbox.frames = sandbox; sandbox.opener = null;
  sandbox.external = { toString() { return 'null'; } };
  sandbox.addEventListener = function (type, fn) { (sandbox._l = sandbox._l || {}); (sandbox._l[type] = sandbox._l[type] || []).push(fn); };
  sandbox.removeEventListener = function () {};

  const documentObj = {
    referrer: '', URL: 'https://cpquery.cnipa.gov.cn/chinesepatent/index', title: '', readyState: 'complete',
    createElement(tag) {
      if (tag === 'canvas') return makeCanvas();
      return { style: {}, setAttribute() {}, appendChild() {}, getContext() { return makeCtx(); },
        addEventListener() {}, getElementsByTagName() { return []; }, querySelector() { return null; } };
    },
    getElementById() { return null; }, querySelector() { return null; }, getElementsByTagName() { return []; },
    addEventListener(type, fn) { (documentObj._l = documentObj._l || {}); (documentObj._l[type] = documentObj._l[type] || []).push(fn); },
    removeEventListener() {}, createTextNode() { return {}; },
    documentElement: { style: {} }, body: { style: {}, appendChild() {}, getElementsByTagName() { return []; } }
  };
  Object.defineProperty(documentObj, 'cookie', {
    get() { return documentObj._c || ''; },
    set(v) { captured.cookies.push(String(v)); documentObj._c = (documentObj._c ? documentObj._c + ' ' : '') + v; },
    configurable: true
  });
  sandbox.document = documentObj;
  documentObj.location = sandbox.location;

  sandbox.navigator = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    appVersion: '5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', language: 'zh-CN', languages: ['zh-CN', 'zh', 'en'],
    cookieEnabled: true, onLine: true, hardwareConcurrency: 8, maxTouchPoints: 0, vendor: 'Google Inc.', webdriver: false
  };
  sandbox.location = {
    href: 'https://cpquery.cnipa.gov.cn/chinesepatent/index', search: '', hash: '', pathname: '/chinesepatent/index',
    host: 'cpquery.cnipa.gov.cn', hostname: 'cpquery.cnipa.gov.cn', protocol: 'https:', port: '',
    reload() { captured.locations.push('reload'); }, assign(u) { captured.locations.push('assign:' + u); },
    replace(u) { captured.locations.push('replace:' + u); }
  };
  sandbox.screen = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 };
  sandbox.history = { pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} };
  sandbox.AudioContext = function () {
    return {
      currentTime: 0, sampleRate: 44100, state: 'running',
      createOscillator() { return { connect() {}, disconnect() {}, start() {}, stop() {}, frequency: { value: 0, setValueAtTime() {} }, type: '' }; },
      createAnalyser() { return { connect() {}, fftSize: 2048, frequencyBinCount: 1024, getByteFrequencyData(a) {}, getFloatFrequencyData(a) {} }; },
      createGain() { return { connect() {}, gain: { value: 0, setValueAtTime() {} } }; },
      destination: {}, close() {}
    };
  };
  sandbox.XMLHttpRequest = function () { return { open() {}, send() {}, setRequestHeader() {}, getAllResponseHeaders() { return ''; }, status: 200, responseText: '', addEventListener() {}, overrideMimeType() {} }; };
  sandbox.fetch = function () { return Promise.resolve({ ok: true, status: 200, headers: { get() { return null; } }, text: () => Promise.resolve(''), json: () => Promise.resolve({}) }); };

  sandbox._$missing = [];
  sandbox._$fs = fs;
  sandbox._$captured = captured;

  sandbox.eval = function (c) {
    if (typeof c === 'string' && c.indexOf('_$mT[_$ne]') !== -1) c = wrapCalls(c);
    return vm.runInContext(c, sandbox);
  };

  return { sandbox, captured, documentObj };
}

function computeCookie(cd, nsd) {
  return new Promise((resolve, reject) => {
    const { sandbox, captured, documentObj } = buildSandbox();
    let vmErr = null;
    // Diagnostic: log any missing global accessed by waf.js (no fallback).
    const diagCtx = new Proxy(sandbox, {
      get(t, k) {
        if (typeof k === 'symbol') return t[k];
        if (!(k in t)) console.error('MISSING_GLOBAL:' + String(k));
        return t[k];
      },
      set(t, k, v) { t[k] = v; return true; },
      has(t, k) { return k in t; },
    });
    try {
      vm.createContext(diagCtx);
      // Tolerant String.prototype.toString (waf.js coerces non-strings via it).
      vm.runInContext('String.prototype.toString = function(){ try { return String(this); } catch(e){ return Object.prototype.toString.call(this); } };', diagCtx);
      vm.runInContext(`
        var _$brls_wc = 0;
        var _$safeProxy_$ = new Proxy(function(){}, { get:function(){return _$safeProxy_$;}, apply:function(){return _$safeProxy_$;}, construct:function(){return _$safeProxy_$;} });
        var _$missCount_$ = 0;
        function _$brls_invoke_$(o,k){
          var f = (o==null)?undefined:o[k];
          if (typeof f === 'function') return f.bind(o);
          _$missCount_$++;
          if (_$missCount_$ > 50000) throw new Error('MISSLOOP c=' + (o&&o.constructor&&o.constructor.name) + ' k=' + String(k));
          _$fs.appendFileSync('missing_async.txt', JSON.stringify({ c:o&&o.constructor&&o.constructor.name, k:String(k), t:typeof f }) + String.fromCharCode(10));
          return _$safeProxy_$;
        }
      `, diagCtx);
      vm.runInContext('window.$_ts = window.$_ts || {}; window.$_ts.nsd = ' + Number(nsd) + '; window.$_ts.cd = ' + JSON.stringify(String(cd)) + ';', diagCtx);

      const wafCode = wrapCalls(fs.readFileSync(WAF_JS, 'utf8'));
      vm.runInContext(wafCode, diagCtx, { filename: 'waf.js' });
    } catch (e) {
      vmErr = e;
      console.error('VM Error:', e.message, e.stack);
    }

    function fire(type) {
      const all = [];
      if (sandbox._l && sandbox._l[type]) all.push.apply(all, sandbox._l[type]);
      if (documentObj._l && documentObj._l[type]) all.push.apply(all, documentObj._l[type]);
      all.forEach(fn => { try { fn({ type: type }); } catch (e) {} });
    }
    ['DOMContentLoaded', 'load', 'readystatechange'].forEach(fire);
    if (typeof sandbox.onload === 'function') { try { sandbox.onload(); } catch (e) {} }

    try {
      if (vm.runInContext('typeof _$oy', diagCtx) === 'function') vm.runInContext('_$oy();', diagCtx);
    } catch (e) { vmErr = vmErr || e; }

    // Allow injected microtasks (crypto) to settle, then read the cookie.
    sandbox.setTimeout(function () {
      if (vmErr) { reject(vmErr); return; }
      const cleanCookie = captured.cookies.map(c => String(c).split(';')[0].trim()).join('; ');
      if (!cleanCookie) { console.error('DBG cookies='+JSON.stringify(captured.cookies)); console.error('DBG logsTail='+JSON.stringify(captured.logs.slice(-20))); reject(new Error('waf.js produced no cookie')); return; }
      resolve(cleanCookie);
    });
  });
}

module.exports = { computeCookie };

if (require.main === module) {
  const cd = process.argv[2] || '';
  const nsd = process.argv[3] ? Number(process.argv[3]) : 82908;
  if (!cd) { console.error('usage: node waf_runner.js <cd> <nsd>'); process.exit(1); }
  computeCookie(cd, nsd).then(c => { console.log('BARECOOKIE|' + c); })
    .catch(e => { console.error('WAF_RUNNER_ERR', e && e.message); process.exit(1); });
}
