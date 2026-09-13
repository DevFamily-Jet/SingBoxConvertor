/**
 * Cloudflare Worker: Sing-box 订阅动态转换服务 (带 KV 映射持久化)
 * 特性:
 * 1. 订阅持久化: 原地址与新地址一对一绑定，机场换域名只需在后台改一次，客户端订阅链接永久不变。
 * 2. 动态拉取与转换: 客户端发起请求时实时向机场请求最新节点，并转换为标准化 Sing-box 1.14/1.15 配置。
 * 3. 智能容错: 启用 FakeIP DNS 模式，彻底解决 Cloudflare CDN 优选节点/WS 协议不支持 UDP 导致的断网问题。
 * 4. 内置管理页面: 开箱即用 Web 界面，提供订阅管理与测试。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. 客户端订阅导出路由: /sub/:id
    if (path.startsWith("/sub/")) {
      const subId = path.substring(5).trim();
      return handleClientSub(request, env, subId, url);
    }

    // 2. 纯动态一次性转换路由: /convert?url=https://...
    if (path === "/convert") {
      const sourceUrl = url.searchParams.get("url");
      if (!sourceUrl) {
        return new Response(JSON.stringify({ error: "Missing ?url= parameter" }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
        });
      }
      return convertFromUrl(sourceUrl, {
        targetVersion: url.searchParams.get("version") || "1.14",
        enableTun: url.searchParams.get("tun") !== "false"
      });
    }

    // 3. 后台 API
    if (path === "/api/list") {
      return handleApiList(request, env, corsHeaders);
    }
    if (path === "/api/create" && request.method === "POST") {
      return handleApiCreate(request, env, corsHeaders);
    }
    if (path === "/api/update" && request.method === "POST") {
      return handleApiUpdate(request, env, corsHeaders);
    }
    if (path === "/api/delete" && request.method === "POST") {
      return handleApiDelete(request, env, corsHeaders);
    }

    // 4. 根路径: 极简可视化管理界面
    if (path === "/" || path === "/index.html") {
      return new Response(renderHtml(url.origin), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate"
        }
      });
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleClientSub(request, env, subId, url) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({
      error: "KV 命名空间 [SUB_KV] 未绑定，请在 Cloudflare 后台或 wrangler.toml 中绑定 KV"
    }, null, 2), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  const rawData = await env.SUB_KV.get("sub:" + subId);
  if (!rawData) {
    return new Response("未找到订阅 ID: " + subId, {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  let subInfo;
  try {
    subInfo = JSON.parse(rawData);
  } catch (e) {
    return new Response("订阅元数据损坏", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  const targetVersion = url.searchParams.get("version") || subInfo.targetVersion || "1.14";
  const enableTun = url.searchParams.get("tun") !== null
    ? url.searchParams.get("tun") !== "false"
    : (subInfo.enableTun !== false);

  const rejectRules = subInfo.rejectRules || {};

  const subIdParam = subId;
  return convertFromUrl(subInfo.sourceUrl, { targetVersion, enableTun, rejectRules, env, subId: subIdParam });
}

async function convertFromUrl(sourceUrl, options = {}) {
  const targetVersion = options.targetVersion || "1.14";
  const enableTun = options.enableTun !== false;
  const rejectRules = options.rejectRules || {};
  const env = options.env;
  const subId = options.subId;

  try {
    const rawContent = await fetchSubscriptionWithRetry(sourceUrl);
    const nodes = parseSubscriptionContent(rawContent);

    if (!nodes || nodes.length === 0) {
      throw new Error("未能从订阅地址解析到任何有效节点");
    }

    const config = generateSingBoxConfig(nodes, { targetVersion, enableTun, rejectRules });
    const configBody = JSON.stringify(config, null, 2);

    // 如果绑定了 KV，将成功生成的配置持久化缓存
    if (env && env.SUB_KV && subId) {
      try {
        await env.SUB_KV.put("cache:sub:" + subId, configBody);
      } catch (kvErr) {
        console.warn("KV put cache error:", kvErr);
      }
    }

    return new Response(configBody, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "subscription-userinfo": "upload=0; download=0; total=1073741824000; expire=0"
      }
    });
  } catch (err) {
    // 降级保护：如果拉取失败，尝试从 KV 缓存中获取上一份健康配置
    if (env && env.SUB_KV && subId) {
      try {
        const cached = await env.SUB_KV.get("cache:sub:" + subId);
        if (cached && cached.trim().startsWith("{") && cached.includes('"outbounds"')) {
          return new Response(cached, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "X-Config-Fallback": "cached-fallback",
              "subscription-userinfo": "upload=0; download=0; total=1073741824000; expire=0"
            }
          });
        }
      } catch (kvReadErr) {
        console.warn("KV get cache error:", kvReadErr);
      }
    }

    // 严禁返回形如 {"error": ...} 的 JSON，防止 sing-box 客户端将其解析为配置时报 unknown field "error" 并彻底破坏工作 Profile！
    return new Response("订阅拉取转换失败: " + (err.message || String(err)), {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

async function fetchSubscriptionWithRetry(url, maxRetries = 2) {
  let lastErr;
  const headers = {
    "User-Agent": "sing-box/1.14.0; clash.meta; Mozilla/5.0",
    "Accept": "*/*"
  };

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const resp = await fetch(url, { headers, redirect: "follow" });
      if (!resp.ok) {
        throw new Error("HTTP 状态码错误: " + resp.status);
      }
      return await resp.text();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

function parseSubscriptionContent(content) {
  if (!content) return [];
  content = content.trim();

  const decoded = safeBase64Decode(content);
  if (decoded && (decoded.includes("://") || decoded.includes("proxies:"))) {
    content = decoded;
  }

  if (content.includes("proxies:")) {
    const clashNodes = parseClashYaml(content);
    if (clashNodes.length > 0) return clashNodes;
  }

  const lines = content.split(/[\r\n]+/);
  const nodes = [];
  const tagCounts = {};

  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    const node = parseSingleLink(line);
    if (node) {
      let tag = node.tag || "node";
      if (tagCounts[tag]) {
        tagCounts[tag]++;
        node.tag = tag + " (" + tagCounts[tag] + ")";
      } else {
        tagCounts[tag] = 1;
      }
      nodes.push(node);
    }
  }

  return nodes;
}

function parseSingleLink(link) {
  try {
    if (link.startsWith("vless://")) return parseVless(link);
    if (link.startsWith("vmess://")) return parseVmess(link);
    if (link.startsWith("trojan://")) return parseTrojan(link);
    if (link.startsWith("ss://")) return parseShadowsocks(link);
    if (link.startsWith("hy2://") || link.startsWith("hysteria2://")) return parseHysteria2(link);
    if (link.startsWith("tuic://")) return parseTuic(link);
  } catch (e) {
    return null;
  }
  return null;
}

function parseVless(link) {
  const url = new URL(link);
  const tag = decodeURIComponent(url.hash ? url.hash.substring(1) : "vless-" + url.hostname);
  const params = url.searchParams;

  const node = {
    type: "vless",
    tag,
    server: url.hostname,
    server_port: parseInt(url.port || "443", 10),
    uuid: url.username
  };

  const flow = params.get("flow");
  if (flow) node.flow = flow;

  const security = params.get("security") || "none";
  if (security === "reality" || security === "tls") {
    const sni = params.get("sni") || url.hostname;
    const tls = {
      enabled: true,
      server_name: sni,
      utls: {
        enabled: true,
        fingerprint: params.get("fp") || "chrome"
      }
    };
    if (security === "reality") {
      tls.reality = {
        enabled: true,
        public_key: params.get("pbk") || "",
        short_id: params.get("sid") || ""
      };
      if (params.get("spx")) tls.reality.spiderx = params.get("spx");
    }
    node.tls = tls;
  }

  const netType = params.get("type") || "tcp";
  if (netType === "ws" || netType === "websocket") {
    node.transport = {
      type: "ws",
      path: params.get("path") || "/",
      headers: { Host: params.get("host") || (node.tls && node.tls.server_name) || url.hostname }
    };
  } else if (netType === "grpc") {
    node.transport = {
      type: "grpc",
      service_name: params.get("serviceName") || ""
    };
  }

  return node;
}

function parseVmess(link) {
  const rawB64 = link.substring(8);
  const jsonStr = safeBase64Decode(rawB64);
  if (!jsonStr) return null;

  const data = JSON.parse(jsonStr);
  const node = {
    type: "vmess",
    tag: data.ps || ("vmess-" + data.add),
    server: data.add,
    server_port: parseInt(data.port || "443", 10),
    uuid: data.id,
    alter_id: parseInt(data.aid || "0", 10),
    security: data.scy || "auto"
  };

  if (String(data.tls).toLowerCase() === "tls" || data.tls === "1" || data.tls === true) {
    node.tls = {
      enabled: true,
      server_name: data.sni || data.add,
      utls: { enabled: true, fingerprint: data.fp || "chrome" }
    };
  }

  if (data.net === "ws") {
    node.transport = {
      type: "ws",
      path: data.path || "/",
      headers: { Host: data.host || (node.tls && node.tls.server_name) || data.add }
    };
  } else if (data.net === "grpc") {
    node.transport = {
      type: "grpc",
      service_name: data.path || ""
    };
  }

  return node;
}

function parseTrojan(link) {
  const url = new URL(link);
  const tag = decodeURIComponent(url.hash ? url.hash.substring(1) : "trojan-" + url.hostname);
  const params = url.searchParams;
  const sni = params.get("sni") || params.get("peer") || url.hostname;

  const node = {
    type: "trojan",
    tag,
    server: url.hostname,
    server_port: parseInt(url.port || "443", 10),
    password: url.username,
    tls: {
      enabled: true,
      server_name: sni
    }
  };

  const fp = params.get("fp") || "chrome";
  node.tls.utls = { enabled: true, fingerprint: fp };
  if (params.get("alpn")) node.tls.alpn = [params.get("alpn")];

  const netType = params.get("type") || "tcp";
  if (netType === "ws" || netType === "websocket") {
    node.transport = {
      type: "ws",
      path: params.get("path") || "/",
      headers: { Host: params.get("host") || sni }
    };
  } else if (netType === "grpc") {
    node.transport = {
      type: "grpc",
      service_name: params.get("serviceName") || ""
    };
  }

  return node;
}

function parseShadowsocks(link) {
  let raw = link.substring(5);
  let tag = "ss-node";
  if (raw.includes("#")) {
    const parts = raw.split("#");
    raw = parts[0];
    tag = decodeURIComponent(parts[1]);
  }

  let method, password, server, port;
  if (raw.includes("@")) {
    const [userinfo, hostport] = raw.split("@");
    const decodedUser = safeBase64Decode(userinfo) || userinfo;
    if (!decodedUser.includes(":")) return null;
    [method, password] = decodedUser.split(":");
    const [h, p] = hostport.split(":");
    server = h;
    port = parseInt(p || "8388", 10);
  } else {
    const decoded = safeBase64Decode(raw);
    if (!decoded || !decoded.includes("@")) return null;
    const [userinfo, hostport] = decoded.split("@");
    [method, password] = userinfo.split(":");
    const [h, p] = hostport.split(":");
    server = h;
    port = parseInt(p || "8388", 10);
  }

  return {
    type: "shadowsocks",
    tag,
    server,
    server_port: port,
    method,
    password
  };
}

function parseHysteria2(link) {
  const cleanLink = link.replace(/^hy2:\/\//, "https://").replace(/^hysteria2:\/\//, "https://");
  const url = new URL(cleanLink);
  const tag = decodeURIComponent(url.hash ? url.hash.substring(1) : "hy2-" + url.hostname);
  const params = url.searchParams;

  const node = {
    type: "hysteria2",
    tag,
    server: url.hostname,
    server_port: parseInt(url.port || "443", 10),
    password: url.username || params.get("auth") || "",
    tls: {
      enabled: true,
      server_name: params.get("sni") || url.hostname,
      insecure: params.get("insecure") === "1" || params.get("insecure") === "true"
    }
  };

  const obfs = params.get("obfs");
  if (obfs) {
    node.obfs = {
      type: obfs,
      password: params.get("obfs-password") || ""
    };
  }

  return node;
}

function parseTuic(link) {
  const cleanLink = link.replace(/^tuic:\/\//, "https://");
  const url = new URL(cleanLink);
  const tag = decodeURIComponent(url.hash ? url.hash.substring(1) : "tuic-" + url.hostname);
  const params = url.searchParams;

  return {
    type: "tuic",
    tag,
    server: url.hostname,
    server_port: parseInt(url.port || "443", 10),
    uuid: url.username,
    password: url.password,
    congestion_control: params.get("congestion_control") || "bbr",
    tls: {
      enabled: true,
      server_name: params.get("sni") || url.hostname
    }
  };
}

// Parse Clash YAML proxies section — handles both block-style and single-line inline {…} format
function parseClashYaml(yamlStr) {
  const lines = yamlStr.split(/\r?\n/);
  let inProxies = false;
  const proxies = [];
  let currentProxy = null;
  let currentSubKey = null;

  for (let rawLine of lines) {
    if (!inProxies) {
      if (/^proxies\s*:/i.test(rawLine)) {
        inProxies = true;
      }
      continue;
    }

    // A top-level key (no leading space, ends with colon) marks the end of proxies section
    if (/^[a-zA-Z0-9_-]+\s*:/.test(rawLine) && !rawLine.startsWith(' ') && !rawLine.startsWith('\t')) {
      break;
    }

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Inline proxy: - { name: ... }
    const inlineMatch = trimmed.match(/^-\s*\{([\s\S]*)\}\s*$/);
    if (inlineMatch) {
      if (currentProxy) {
        const conv = convertClashItem(currentProxy);
        if (conv) proxies.push(conv);
      }
      currentProxy = clashParseInlineMap(inlineMatch[1]);
      const conv = convertClashItem(currentProxy);
      if (conv) proxies.push(conv);
      currentProxy = null;
      currentSubKey = null;
      continue;
    }

    // Start of a new block proxy: starts with '-'
    if (trimmed.startsWith('-')) {
      if (currentProxy) {
        const conv = convertClashItem(currentProxy);
        if (conv) proxies.push(conv);
      }
      currentProxy = {};
      currentSubKey = null;
      const rest = trimmed.substring(1).trim();
      if (rest && rest.includes(':')) {
        clashSetKV(rest, currentProxy);
      }
      continue;
    }

    if (!currentProxy) continue;

    // Indented lines under currentProxy
    const indent = rawLine.search(/\S/);
    if (trimmed.endsWith(':')) {
      const k = trimmed.slice(0, -1).trim().replace(/^['"]|['"]$/g, '');
      currentProxy[k] = currentProxy[k] || {};
      currentSubKey = k;
    } else if (trimmed.includes(':')) {
      const idx = trimmed.indexOf(':');
      const k = trimmed.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
      let v = trimmed.slice(idx + 1).trim();
      if (v.startsWith('[') && v.endsWith(']')) {
        v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
      } else {
        v = v.replace(/^['"]|['"]$/g, '');
        if (v === 'true') v = true;
        else if (v === 'false') v = false;
        else if (/^\d+$/.test(v)) v = parseInt(v, 10);
      }

      if (indent >= 6 && currentSubKey) {
        if (typeof currentProxy[currentSubKey] !== 'object') currentProxy[currentSubKey] = {};
        currentProxy[currentSubKey][k] = v;
      } else if (indent >= 4 && currentSubKey && !['type','server','port','password','uuid','cipher','network'].includes(k)) {
        currentProxy[currentSubKey][k] = v;
      } else {
        currentSubKey = null;
        currentProxy[k] = v;
      }
    }
  }
  if (currentProxy) {
    const conv = convertClashItem(currentProxy);
    if (conv) proxies.push(conv);
  }
  return proxies;
}

function clashSetKV(str, obj) {
  const idx = str.indexOf(":");
  if (idx === -1) return;
  const k = str.slice(0, idx).trim().replace(/^['"]|['"]$/g, "");
  const rawV = str.slice(idx + 1).trim();
  if (rawV.startsWith("{") && rawV.endsWith("}")) {
    obj[k] = clashParseInlineMap(rawV.slice(1, -1));
  } else if (rawV.startsWith("[") && rawV.endsWith("]")) {
    obj[k] = clashSplitComma(rawV.slice(1, -1)).map(s => s.trim().replace(/^['"]|['"]$/g, ""));
  } else {
    let v = rawV.replace(/^['"]|['"]$/g, "");
    if (v === "true") v = true;
    else if (v === "false") v = false;
    else if (/^\d+$/.test(v)) v = parseInt(v, 10);
    obj[k] = v;
  }
}

function clashParseInlineMap(str) {
  const obj = {};
  for (const token of clashSplitComma(str)) {
    clashSetKV(token.trim(), obj);
  }
  return obj;
}

// Split by commas, respecting nested {} [] and quoted strings
function clashSplitComma(str) {
  const parts = [];
  let cur = "";
  let depth = 0;
  let inQ = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if ((ch === '"' || ch === "'") && !inQ) { inQ = ch; cur += ch; }
    else if (ch === inQ) { inQ = null; cur += ch; }
    else if (!inQ && (ch === "{" || ch === "[")) { depth++; cur += ch; }
    else if (!inQ && (ch === "}" || ch === "]")) { depth--; cur += ch; }
    else if (!inQ && depth === 0 && ch === ",") { parts.push(cur); cur = ""; }
    else { cur += ch; }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function convertClashItem(c) {
  const type = (c.type || "").toLowerCase();
  const tag = c.name || "clash-node";
  const server = c.server;
  const port = parseInt(c.port || "443", 10);
  if (!server) return null;

  // Build TLS object from Clash proxy fields
  function buildTls() {
    const tls = {
      enabled: true,
      server_name: c.servername || c.sni || server,
      utls: {
        enabled: true,
        fingerprint: c["client-fingerprint"] || c.fingerprint || "chrome"
      }
    };
    if (c.alpn) tls.alpn = Array.isArray(c.alpn) ? c.alpn : [c.alpn];
    const ro = c["reality-opts"];
    if (ro) {
      tls.reality = {
        enabled: true,
        public_key: ro["public-key"] || "",
        short_id: ro["short-id"] || ""
      };
    }
    const eo = c["ech-opts"];
    if (eo && (eo.enable === true || eo.enable === "true")) {
      tls.ech = {
        enabled: true,
        query_server_name: eo["query-server-name"] || "cloudflare-ech.com"
      };
    }
    if (c["skip-cert-verify"] === true || c["skip-cert-verify"] === "true") {
      tls.insecure = true;
    }
    return tls;
  }

  // Build transport from Clash network field
  function buildTransport() {
    const net = (c.network || c.net || "tcp").toLowerCase();
    if (net === "ws" || net === "websocket") {
      const wo = c["ws-opts"] || {};
      const wh = (wo && wo.headers) || c.headers || {};
      const path = wo.path || c.path || "/";
      const wsObj = {
        type: "ws",
        path,
        headers: { Host: wh.Host || wh.host || c.host || c.servername || server }
      };
      if (path.includes("ed=") || c["max-early-data"]) {
        wsObj.max_early_data = 2048;
        wsObj.early_data_header_name = "Sec-WebSocket-Protocol";
      }
      return wsObj;
    }
    if (net === "grpc") {
      const go = c["grpc-opts"] || {};
      return { type: "grpc", service_name: go["grpc-service-name"] || go.serviceName || "" };
    }
    if (net === "h2" || net === "http") {
      const ho = c["h2-opts"] || c["http-opts"] || {};
      return {
        type: "http",
        host: ho.host ? [].concat(ho.host) : [server],
        path: ho.path ? [].concat(ho.path)[0] : "/"
      };
    }
    return null;
  }

  if (type === "vless") {
    const node = { type: "vless", tag, server, server_port: port, uuid: c.uuid };
    if (c.flow) node.flow = c.flow;
    const hasTls = c.tls === true || c.tls === "true" || c["reality-opts"] || c["ech-opts"];
    if (hasTls) node.tls = buildTls();
    const tr = buildTransport();
    if (tr) node.transport = tr;
    return node;
  }

  if (type === "vmess") {
    const node = {
      type: "vmess", tag, server, server_port: port,
      uuid: c.uuid,
      alter_id: parseInt(c.alterId || "0", 10),
      security: c.cipher || "auto"
    };
    if (c.tls === true || c.tls === "true") node.tls = buildTls();
    const tr = buildTransport();
    if (tr) node.transport = tr;
    return node;
  }

  if (type === "trojan") {
    const node = {
      type: "trojan", tag, server, server_port: port, password: c.password,
      tls: buildTls()
    };
    const tr = buildTransport();
    if (tr) node.transport = tr;
    return node;
  }

  if (type === "ss") {
    return { type: "shadowsocks", tag, server, server_port: port, method: c.cipher, password: c.password };
  }

  if (type === "hysteria2" || type === "hy2") {
    const node = {
      type: "hysteria2", tag, server, server_port: port,
      password: c.password || c.auth || "",
      tls: {
        enabled: true,
        server_name: c.sni || c.servername || server,
        insecure: c["skip-cert-verify"] === true || c["skip-cert-verify"] === "true"
      }
    };
    if (c.obfs) node.obfs = { type: c.obfs, password: c["obfs-password"] || "" };
    return node;
  }

  if (type === "tuic") {
    return {
      type: "tuic", tag, server, server_port: port,
      uuid: c.uuid, password: c.password,
      congestion_control: c["congestion-controller"] || "bbr",
      tls: { enabled: true, server_name: c.sni || c.servername || server }
    };
  }

  return null;
}

function safeBase64Decode(str) {
  try {
    str = str.trim().replace(/-/g, "+").replace(/_/g, "/");
    while (str.length % 4) str += "=";
    return atob(str);
  } catch (e) {
    return null;
  }
}

function generateSingBoxConfig(nodes, { targetVersion = "1.14", enableTun = true, rejectRules = {} }) {
  const nodeTags = nodes.map(n => n.tag);
  const selectorOutbounds = ["auto", ...nodeTags, "direct"];

  const inbounds = [];
  if (enableTun) {
    inbounds.push({
      type: "tun",
      tag: "tun-in",
      interface_name: "singbox-tun",
      mtu: 1400,
      address: [
        "172.19.0.1/30",
        "fdfe:dcba:9876::1/126"
      ],
      auto_route: true,
      strict_route: true,
      endpoint_independent_nat: true
    });
  }
  inbounds.push({
    type: "mixed",
    tag: "mixed-in",
    listen: "127.0.0.1",
    listen_port: 2080
  });

  const outbounds = [
    {
      type: "selector",
      tag: "proxy",
      outbounds: selectorOutbounds
    },
    {
      type: "urltest",
      tag: "auto",
      outbounds: nodeTags.length > 0 ? nodeTags : ["direct"],
      url: "http://www.gstatic.com/generate_204",
      interval: "2m",
      idle_timeout: "30m",
      tolerance: 50,
      interrupt_exist_connections: false
    },
    ...nodes,
    {
      type: "direct",
      tag: "direct"
    },
    {
      type: "block",
      tag: "block"
    }
  ];

  // 初始 DNS 规则 (用户自定义域名在此拦截)
  const dnsRules = [];

  // Route 规则构建
  const routeRules = [
    {
      action: "sniff"
    },
    {
      action: "hijack-dns",
      protocol: "dns"
    },
    // ECH 域名直连 (防止循环死锁)
    {
      action: "route",
      domain_suffix: [
        "cloudflare-ech.com"
      ],
      outbound: "direct"
    },
    // GitHub 及其所有资源域名强制走代理 (国内直连必定受阻)
    {
      action: "route",
      domain_suffix: [
        "github.com",
        "githubusercontent.com",
        "githubassets.com",
        "github.io",
        "githubapp.com"
      ],
      outbound: "proxy"
    },
    // Google 遥测与服务域名走代理，避免被国内直连阻断导致超时
    {
      action: "route",
      domain_suffix: [
        "gvt1.com",
        "gvt2.com",
        "gcp.gvt2.com"
      ],
      outbound: "proxy"
    },
    // 防止其他代理软件 (Clash Verge / v2rayN) 与 sing-box TUN 发生路由回环死锁
    {
      action: "route",
      process_name: [
        "verge-mihomo-alpha.exe",
        "clash-verge.exe",
        "clash.exe",
        "mihomo.exe",
        "v2rayN.exe",
        "v2ray.exe",
        "xray.exe"
      ],
      outbound: "direct"
    },
    {
      action: "reject",
      rule_set: "geosite-category-ads-all"
    }
  ];

  // 1. 自定义域名拒绝 (DNS & Route)
  const customDomains = Array.isArray(rejectRules.domains) ? rejectRules.domains : [];
  if (customDomains.length > 0) {
    const domainSuffixes = new Set();
    const exactDomains = new Set();
    const domainKeywords = new Set();

    customDomains.forEach(d => {
      d = String(d).trim().toLowerCase();
      if (!d) return;

      // 提取核心域名
      let clean = d;
      if (clean.startsWith("*.")) clean = clean.substring(2);
      else if (clean.startsWith(".")) clean = clean.substring(1);

      if (!clean) return;

      exactDomains.add(clean);
      domainSuffixes.add(clean);
      // 同时添加 keyword 确保不论多级子域名 a.b.vivo.com.cn 还是嗅探阶段都能100%命中
      domainKeywords.add(clean);
    });

    const suffixesArr = Array.from(domainSuffixes);
    const exactArr = Array.from(exactDomains);
    const keywordArr = Array.from(domainKeywords);

    const dnsRule = {
      action: "reject",
      domain_suffix: suffixesArr,
      domain: exactArr
    };
    const routeRule = {
      action: "reject",
      domain_suffix: suffixesArr,
      domain: exactArr,
      domain_keyword: keywordArr
    };

    dnsRules.push(dnsRule);
    routeRules.push(routeRule);
  }

  // 2. 自定义 IP / CIDR 拒绝 (Route)
  const customIps = Array.isArray(rejectRules.ips) ? rejectRules.ips : [];
  if (customIps.length > 0) {
    routeRules.push({ action: "reject", ip_cidr: customIps });
  }

  // 3. 自定义包名 / 进程名拒绝 (兼容 Android package_name 和 Windows/Linux/macOS process_name)
  const customPackages = Array.isArray(rejectRules.packages) ? rejectRules.packages : [];
  if (customPackages.length > 0) {
    const androidPkgs = new Set();
    const procs = new Set();

    customPackages.forEach(p => {
      p = String(p).trim();
      if (!p) return;
      const lower = p.toLowerCase();

      // Android 包名通常包含点且不以 .exe 结尾，如 com.vivo.browser
      if (p.includes(".") && !lower.endsWith(".exe")) {
        androidPkgs.add(p);
      }

      // 桌面进程名
      if (lower.endsWith(".exe")) {
        procs.add(p);
      } else {
        // 不带 .exe 的也同时添加原型和 .exe 版本，兼容 Linux/macOS/Windows
        procs.add(p);
        procs.add(p + ".exe");
      }
    });

    if (androidPkgs.size > 0) {
      routeRules.push({ action: "reject", package_name: Array.from(androidPkgs) });
    }
    if (procs.size > 0) {
      routeRules.push({ action: "reject", process_name: Array.from(procs) });
    }
  }

  dnsRules.push(
    {
      action: "route",
      domain_suffix: [
        "cloudflare-ech.com",
        "cdn-apple.com",
        "apple.com"
      ],
      server: "dns-direct"
    },
    {
      action: "route",
      rule_set: "geosite-cn",
      server: "dns-direct"
    },
    {
      action: "route",
      query_type: ["A", "AAAA"],
      server: "dns-fakeip"
    },
    {
      action: "route",
      server: "dns-remote"
    }
  );

  const ruleSets = [
    {
      tag: "geosite-category-ads-all",
      type: "remote",
      format: "binary",
      url: "https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-category-ads-all.srs"
    },
    {
      tag: "geosite-geolocation-!cn",
      type: "remote",
      format: "binary",
      url: "https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-geolocation-!cn.srs"
    },
    {
      tag: "geosite-cn",
      type: "remote",
      format: "binary",
      url: "https://fastly.jsdelivr.net/gh/SagerNet/sing-geosite@rule-set/geosite-cn.srs"
    },
    {
      tag: "geoip-cn",
      type: "remote",
      format: "binary",
      url: "https://fastly.jsdelivr.net/gh/SagerNet/sing-geoip@rule-set/geoip-cn.srs"
    }
  ];


  const dns = {
    servers: [
      {
        tag: "dns-fakeip",
        type: "fakeip",
        inet4_range: "198.18.0.0/15",
        inet6_range: "fc00::/18"
      },
      {
        tag: "dns-direct",
        type: "udp",
        server: "223.5.5.5"
      },
      {
        tag: "dns-remote",
        type: "tcp",
        server: "8.8.8.8",
        detour: "proxy"
      }
    ],
    rules: dnsRules,
    final: "dns-remote"
  };

  routeRules.push(
    {
      action: "route",
      ip_is_private: true,
      outbound: "direct"
    },
    {
      action: "route",
      rule_set: ["geoip-cn", "geosite-cn"],
      outbound: "direct"
    },
    {
      action: "route",
      rule_set: "geosite-geolocation-!cn",
      outbound: "proxy"
    },
    {
      action: "route",
      outbound: "proxy"
    }
  );

  const route = {
    auto_detect_interface: true,
    default_domain_resolver: "dns-direct",
    rules: routeRules,
    rule_set: ruleSets
  };

  return {
    log: {
      level: "info",
      timestamp: true
    },
    dns,
    inbounds,
    outbounds,
    route,
    experimental: {
      clash_api: {
        external_controller: "127.0.0.1:9090",
        secret: ""
      },
      cache_file: {
        enabled: true,
        path: "cache.db",
        store_fakeip: true,
        store_dns: true
      }
    },
    http_clients: [
      {
        tag: "default",
        detour: "proxy"
      }
    ]
  };
}

async function handleApiList(request, env, corsHeaders) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({ error: "SUB_KV not bound" }), { status: 500, headers: corsHeaders });
  }
  const list = await env.SUB_KV.list({ prefix: "sub:" });
  const items = [];
  for (let key of list.keys) {
    const raw = await env.SUB_KV.get(key.name);
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        items.push({ id: key.name.replace("sub:", ""), ...obj });
      } catch (e) {}
    }
  }
  return new Response(JSON.stringify({ items }), {
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
  });
}

async function handleApiCreate(request, env, corsHeaders) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({ error: "SUB_KV not bound" }), { status: 500, headers: corsHeaders });
  }
  const body = await request.json();
  const id = (body.id || Math.random().toString(36).substring(2, 10)).trim();
  const sourceUrl = (body.sourceUrl || "").trim();

  if (!sourceUrl || !sourceUrl.startsWith("http")) {
    return new Response(JSON.stringify({ error: "请输入有效的原订阅 HTTP/HTTPS 链接" }), {
      status: 400,
      headers: corsHeaders
    });
  }

  const data = {
    sourceUrl,
    name: body.name || "默认订阅",
    targetVersion: body.targetVersion || "1.14",
    enableTun: body.enableTun !== false,
    rejectRules: {
      domains: parseInputList(body.rejectDomains),
      ips: parseInputList(body.rejectIps),
      packages: parseInputList(body.rejectPackages)
    },
    updatedAt: new Date().toISOString()
  };

  await env.SUB_KV.put("sub:" + id, JSON.stringify(data));
  return new Response(JSON.stringify({ success: true, id, data }), { headers: corsHeaders });
}

async function handleApiUpdate(request, env, corsHeaders) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({ error: "SUB_KV not bound" }), { status: 500, headers: corsHeaders });
  }
  const body = await request.json();
  const id = (body.id || "").trim();
  if (!id) {
    return new Response(JSON.stringify({ error: "缺少订阅 ID" }), { status: 400, headers: corsHeaders });
  }

  const existing = await env.SUB_KV.get("sub:" + id);
  if (!existing) {
    return new Response(JSON.stringify({ error: "订阅不存在" }), { status: 404, headers: corsHeaders });
  }

  const prev = JSON.parse(existing);
  const data = {
    ...prev,
    sourceUrl: body.sourceUrl ? body.sourceUrl.trim() : prev.sourceUrl,
    name: body.name || prev.name,
    targetVersion: body.targetVersion || prev.targetVersion,
    enableTun: body.enableTun !== undefined ? body.enableTun : prev.enableTun,
    rejectRules: {
      domains: body.rejectDomains !== undefined ? parseInputList(body.rejectDomains) : (prev.rejectRules?.domains || []),
      ips: body.rejectIps !== undefined ? parseInputList(body.rejectIps) : (prev.rejectRules?.ips || []),
      packages: body.rejectPackages !== undefined ? parseInputList(body.rejectPackages) : (prev.rejectRules?.packages || [])
    },
    updatedAt: new Date().toISOString()
  };

  await env.SUB_KV.put("sub:" + id, JSON.stringify(data));
  return new Response(JSON.stringify({ success: true, id, data }), { headers: corsHeaders });
}

async function handleApiDelete(request, env, corsHeaders) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({ error: "SUB_KV not bound" }), { status: 500, headers: corsHeaders });
  }
  const body = await request.json();
  const id = (body.id || "").trim();
  if (id) {
    await env.SUB_KV.delete("sub:" + id);
  }
  return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
}

function parseInputList(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.map(s => String(s).trim()).filter(Boolean);
  return String(val).split(/[\s,\r\n]+/).map(s => s.trim()).filter(Boolean);
}

function renderHtml(origin) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sing-box 订阅转换托管中心 (CF Worker + KV)</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --accent: #10b981;
      --accent-hover: #059669;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
      --danger: #ef4444;
      --warning: #f59e0b;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 28px 16px; min-height: 100vh; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 900px; }
    .header { text-align: center; margin-bottom: 28px; }
    .header h1 { font-size: 26px; color: var(--accent); margin-bottom: 8px; }
    .header p { color: var(--text-muted); font-size: 14px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.2); }
    .card h2 { font-size: 18px; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-size: 13px; font-weight: 500; margin-bottom: 6px; color: var(--text-muted); }
    .label-hint { font-size: 12px; color: #64748b; font-weight: normal; margin-left: 6px; }
    input, select, textarea { width: 100%; padding: 10px 12px; border-radius: 6px; border: 1px solid var(--border); background: #0f172a; color: var(--text); font-size: 14px; transition: border-color 0.2s; }
    input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
    textarea { resize: vertical; min-height: 64px; font-family: monospace; font-size: 13px; }
    .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
    .btn { background: var(--accent); color: #000; font-weight: 600; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; transition: 0.2s; }
    .btn:hover { background: var(--accent-hover); }
    .btn-sm { padding: 6px 12px; font-size: 12px; }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-danger:hover { opacity: 0.9; }
    .btn-secondary { background: #334155; color: #fff; }
    .btn-secondary:hover { background: #475569; }
    
    .rules-section {
      background: #131d2e;
      border: 1px solid #1e3a5f;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .rules-header {
      font-size: 14px;
      font-weight: 600;
      color: #38bdf8;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .sub-item { background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 10px; }
    .sub-header { display: flex; justify-content: space-between; align-items: center; }
    .sub-title { font-weight: 600; font-size: 16px; color: var(--accent); }
    .sub-url { word-break: break-all; font-family: monospace; font-size: 12px; color: #38bdf8; background: #1e293b; padding: 8px 12px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; }
    .copy-btn { cursor: pointer; color: var(--accent); margin-left: 10px; font-weight: 500; }
    .copy-btn:hover { text-decoration: underline; }
    .meta-tag { font-size: 12px; color: var(--text-muted); word-break: break-all; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #334155; color: #94a3b8; margin-right: 6px; }
    .badge-reject { background: #7f1d1d; color: #fca5a5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ Sing-box 订阅托管转换中心</h1>
      <p>Cloudflare 边缘极速生成 · KV 永久联动更新 · FakeIP 零延迟智能分流 · 自定义拦截审计</p>
    </div>

    <!-- 创建新订阅 -->
    <div class="card">
      <h2>➕ 创建 / 绑定新订阅</h2>
      
      <div class="form-group">
        <label>订阅备注名称</label>
        <input type="text" id="subName" placeholder="例如: 主力机场">
      </div>
      
      <div class="form-group">
        <label>原订阅地址 (HTTP/HTTPS 链接)</label>
        <input type="text" id="sourceUrl" placeholder="https://airport.com/api/v1/client/subscribe?token=...">
      </div>

      <div class="grid-2">
        <div class="form-group">
          <label>自定义短链 ID <span class="label-hint">(可选，留空自动生成)</span></label>
          <input type="text" id="subId" placeholder="例如: myvpn">
        </div>
        <div class="form-group">
          <label>目标 Sing-box 规范版本</label>
          <select id="targetVersion">
            <option value="1.14" selected>Sing-box 1.14+ (稳定版，支持 FakeIP)</option>
            <option value="1.15">Sing-box 1.15+ (最新先行版)</option>
          </select>
        </div>
      </div>

      <!-- 自定义拒绝与拦截规则面板 -->
      <div class="rules-section">
        <div class="rules-header">
          🛡️ 自定义拒绝拦截规则 (Reject Rules)
          <span class="label-hint" style="color: #94a3b8;">命中的流量将在 DNS 和路由层直接拒接 (Action: reject)</span>
        </div>
        
        <div class="grid-3">
          <div class="form-group">
            <label>拒绝域名 (Domain / Suffix)<span class="label-hint">逗号或换行分隔</span></label>
            <textarea id="rejectDomains" placeholder="例如:&#10;tiktok.com&#10;douyin.com&#10;*.pinduoduo.com"></textarea>
          </div>
          
          <div class="form-group">
            <label>拒绝 IP 地址段 (IP / CIDR)<span class="label-hint">逗号或换行分隔</span></label>
            <textarea id="rejectIps" placeholder="例如:&#10;123.56.78.90/32&#10;203.0.113.0/24"></textarea>
          </div>

          <div class="form-group">
            <label>拒绝应用包名 / 进程名<span class="label-hint">安卓包名或电脑进程</span></label>
            <textarea id="rejectPackages" placeholder="例如:&#10;com.ss.android.ugc.aweme&#10;WeChat.exe&#10;douyin.exe"></textarea>
          </div>
        </div>
      </div>

      <button class="btn" onclick="createSub()">⚡ 生成永久专属订阅地址</button>
    </div>

    <!-- 订阅列表 -->
    <div class="card">
      <h2>
        <span>📋 我的托管订阅列表</span>
        <button class="btn btn-sm btn-secondary" onclick="loadSubs()">🔄 刷新列表</button>
      </h2>
      <div id="subList">加载中...</div>
    </div>
  </div>

  <script>
    const origin = window.location.origin;

    async function loadSubs() {
      const container = document.getElementById('subList');
      container.innerHTML = '正在读取 KV 数据...';
      try {
        const res = await fetch('/api/list');
        const data = await res.json();
        if (data.error) {
          container.innerHTML = '<div style="color: #f87171;">' + data.error + '</div>';
          return;
        }
        if (!data.items || data.items.length === 0) {
          container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 20px;">暂无托管订阅，请在上方添加！</div>';
          return;
        }
        container.innerHTML = '';
        data.items.forEach(item => {
          const clientUrl = origin + '/sub/' + item.id;
          const rules = item.rejectRules || {};
          const domainCount = (rules.domains || []).length;
          const ipCount = (rules.ips || []).length;
          const pkgCount = (rules.packages || []).length;

          let rejectBadges = '';
          if (domainCount > 0 || ipCount > 0 || pkgCount > 0) {
            rejectBadges = '<span class="badge badge-reject">已拦截: ' +
              (domainCount ? domainCount + ' 域名 ' : '') +
              (ipCount ? ipCount + ' IP ' : '') +
              (pkgCount ? pkgCount + ' 应用/进程' : '') +
              '</span>';
          }

          const div = document.createElement('div');
          div.className = 'sub-item';
          div.id = 'sub-item-' + item.id;
          div.innerHTML =
            '<div class="sub-header">' +
              '<div>' +
                '<span class="sub-title">' + (item.name || '未命名') + '</span> ' +
                '<span class="badge">ID: ' + item.id + '</span> ' +
                '<span class="badge">v' + (item.targetVersion || '1.14') + '</span> ' +
                rejectBadges +
              '</div>' +
              '<div style="display:flex;gap:6px;">' +
                '<button class="btn btn-sm btn-secondary btn-edit" data-id="' + item.id + '">✏️ 编辑</button>' +
                '<button class="btn btn-sm btn-danger btn-del" data-id="' + item.id + '">删除</button>' +
              '</div>' +
            '</div>' +
            '<div class="meta-tag">原地址: ' + item.sourceUrl + '</div>' +
            '<div class="sub-url">' +
              '<span>' + clientUrl + '</span>' +
              '<span class="copy-btn btn-copy" data-url="' + clientUrl + '">复制新订阅</span>' +
            '</div>';

          div.querySelector('.btn-edit').addEventListener('click', () => editSub(item.id));
          div.querySelector('.btn-del').addEventListener('click', () => deleteSub(item.id));
          div.querySelector('.btn-copy').addEventListener('click', () => copyText(clientUrl));

          container.appendChild(div);
        });
      } catch (e) {
        container.innerHTML = '<div style="color: #f87171;">获取失败: ' + e.message + '</div>';
      }
    }

    async function createSub() {
      const btn = document.querySelector('button.btn');
      const name = document.getElementById('subName').value.trim();
      const sourceUrl = document.getElementById('sourceUrl').value.trim();
      const id = document.getElementById('subId').value.trim();
      const targetVersion = document.getElementById('targetVersion').value;
      const rejectDomains = document.getElementById('rejectDomains').value;
      const rejectIps = document.getElementById('rejectIps').value;
      const rejectPackages = document.getElementById('rejectPackages').value;

      if (!sourceUrl) { alert('请输入原订阅地址！'); return; }

      const origText = btn.innerHTML;
      btn.innerHTML = '⏳ 正在处理并写入 KV...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, sourceUrl, id, targetVersion, rejectDomains, rejectIps, rejectPackages })
        });
        const ret = await res.json();
        if (ret.success) {
          const fileMsg = ret.filePath ? ('\\n\\n📁 本地文件已生成保存：\\n' + ret.filePath + '\\n(后台关闭后此文件不会自动删除，可长期用于调试)') : '';
          alert('🎉 创建成功！专属订阅地址已生成并绑定。' + fileMsg);
          ['sourceUrl','subId','rejectDomains','rejectIps','rejectPackages'].forEach(k => document.getElementById(k).value = '');
          loadSubs();
        } else {
          if (ret.error && ret.error.includes('SUB_KV')) {
            alert('❌ 失败: 未在 Cloudflare 后台绑定 KV！\\n\\n请前往 Worker 的 [设置] → [变量] → [KV 命名空间绑定] 添加 SUB_KV。');
          } else {
            alert('失败: ' + (ret.error || '未知错误'));
          }
        }
      } catch (e) {
        alert('❌ 请求异常: ' + e.message);
      } finally {
        btn.innerHTML = origText;
        btn.disabled = false;
      }
    }

    // ---- 编辑订阅 ----
    let _editingId = null;

    async function editSub(id) {
      // 先获取当前数据
      const res = await fetch('/api/list');
      const data = await res.json();
      const item = (data.items || []).find(i => i.id === id);
      if (!item) { alert('未找到订阅'); return; }

      _editingId = id;
      const rules = item.rejectRules || {};
      document.getElementById('editId').textContent = id;
      document.getElementById('editName').value = item.name || '';
      document.getElementById('editSourceUrl').value = item.sourceUrl || '';
      document.getElementById('editTargetVersion').value = item.targetVersion || '1.14';
      document.getElementById('editRejectDomains').value = (rules.domains || []).join('\\n');
      document.getElementById('editRejectIps').value = (rules.ips || []).join('\\n');
      document.getElementById('editRejectPackages').value = (rules.packages || []).join('\\n');
      document.getElementById('editModal').style.display = 'flex';
    }

    function closeEdit() {
      document.getElementById('editModal').style.display = 'none';
      _editingId = null;
    }

    async function saveEdit() {
      if (!_editingId) return;
      const btn = document.getElementById('editSaveBtn');
      btn.disabled = true;
      btn.textContent = '保存中...';
      try {
        const res = await fetch('/api/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: _editingId,
            name: document.getElementById('editName').value.trim(),
            sourceUrl: document.getElementById('editSourceUrl').value.trim(),
            targetVersion: document.getElementById('editTargetVersion').value,
            rejectDomains: document.getElementById('editRejectDomains').value,
            rejectIps: document.getElementById('editRejectIps').value,
            rejectPackages: document.getElementById('editRejectPackages').value
          })
        });
        const ret = await res.json();
        if (ret.success) {
          closeEdit();
          loadSubs();
          const fileMsg = ret.filePath ? ('\\n\\n📁 本地文件已重新生成并覆盖保存：\\n' + ret.filePath + '\\n(后台关闭后此文件不会自动删除，可长期用于调试)') : '';
          alert('✅ 配置保存成功！' + fileMsg);
        } else {
          alert('保存失败: ' + (ret.error || '未知错误'));
        }
      } catch(e) {
        alert('保存失败: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '💾 保存';
      }
    }

    async function deleteSub(id) {
      if (!confirm('确定删除此订阅映射吗？')) return;
      await fetch('/api/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
      loadSubs();
    }

    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => { alert('已复制客户端订阅地址到剪贴板！'); });
    }

    loadSubs();
  </script>

  <!-- 编辑弹窗 -->
  <div id="editModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:999;align-items:center;justify-content:center;">
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px;width:100%;max-width:620px;max-height:90vh;overflow-y:auto;position:relative;">
      <h2 style="font-size:18px;margin-bottom:20px;color:#10b981;">✏️ 编辑订阅 &nbsp;<span id="editId" style="font-size:13px;color:#94a3b8;font-weight:400;"></span></h2>

      <div class="form-group">
        <label>备注名称</label>
        <input type="text" id="editName">
      </div>
      <div class="form-group">
        <label>原订阅地址</label>
        <input type="text" id="editSourceUrl">
      </div>
      <div class="form-group">
        <label>目标版本</label>
        <select id="editTargetVersion">
          <option value="1.14">Sing-box 1.14+</option>
          <option value="1.15">Sing-box 1.15+</option>
        </select>
      </div>

      <div class="rules-section">
        <div class="rules-header">🛡️ 自定义拒绝拦截规则</div>
        <div class="grid-3">
          <div class="form-group">
            <label>拒绝域名<span class="label-hint">每行一个</span></label>
            <textarea id="editRejectDomains" placeholder="tiktok.com&#10;douyin.com&#10;*.pinduoduo.com"></textarea>
          </div>
          <div class="form-group">
            <label>拒绝 IP/CIDR<span class="label-hint">每行一个</span></label>
            <textarea id="editRejectIps" placeholder="123.56.78.90/32&#10;203.0.113.0/24"></textarea>
          </div>
          <div class="form-group">
            <label>拒绝包名/进程<span class="label-hint">每行一个</span></label>
            <textarea id="editRejectPackages" placeholder="com.ss.android.ugc.aweme&#10;douyin.exe"></textarea>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:12px;margin-top:8px;">
        <button id="editSaveBtn" class="btn" onclick="saveEdit()">💾 保存</button>
        <button class="btn btn-secondary" onclick="closeEdit()">取消</button>
      </div>
    </div>
  </div>
</body>
</html>`;
}