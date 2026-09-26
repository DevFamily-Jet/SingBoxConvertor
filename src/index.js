/**
 * Cloudflare Worker: Sing-box 订阅动态转换服务 (带 KV 映射持久化)
 * 特性:
 * 1. 订阅持久化: 原地址与新地址一对一绑定，机场换域名只需在后台改一次，客户端订阅链接永久不变。
 * 2. 动态拉取与转换: 客户端发起请求时实时向机场请求最新节点，并转换为标准化 Sing-box 1.15+ 配置。
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
        targetVersion: url.searchParams.get("version") || "1.15",
        enableTun: url.searchParams.get("tun") !== "false"
      });
    }

    // 3. 后台订阅管理 API
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

    // 规则配置文件 API
    if (path === "/api/rule_profiles/list") {
      return handleApiRuleProfilesList(request, env, corsHeaders);
    }
    if (path === "/api/rule_profiles/create" && request.method === "POST") {
      return handleApiRuleProfilesCreate(request, env, corsHeaders);
    }
    if (path === "/api/rule_profiles/update" && request.method === "POST") {
      return handleApiRuleProfilesUpdate(request, env, corsHeaders);
    }
    if (path === "/api/rule_profiles/delete" && request.method === "POST") {
      return handleApiRuleProfilesDelete(request, env, corsHeaders);
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

const DEFAULT_RULE_PROFILES = [
  {
    id: "default",
    name: "默认基础拦截 (广告SDK / 追踪 / 短视频)",
    description: "拦截主流广告追踪联盟、开屏SDK及短视频后台数据同步",
    domains: [
      "*.pangolin-sdk-toutiao.com",
      "*.pglstatp-toutiao.com",
      "*.pangle-ads.com",
      "adservice.google.com",
      "app-measurement.com",
      "analytics.google.com",
      "*.umeng.com",
      "*.umengcloud.com",
      "*.open.e.kuaishou.com",
      "*.ad.xiaomi.com"
    ],
    ips: [],
    packages: [
      "com.ss.android.*",
      "com.smile.gifmaker",
      "com.kuaishou.nebula",
      "com.xunmeng.pinduoduo",
      "pinduoduo.exe"
    ]
  },
  {
    id: "strict",
    name: "强力隐私防护 (含大数据埋点与厂商遥测)",
    description: "在默认规则基础上，额外拦截设备指纹收集、用户行为埋点上报及国内厂商遥测",
    domains: [
      "*.pangolin-sdk-toutiao.com",
      "*.pglstatp-toutiao.com",
      "*.pangle-ads.com",
      "adservice.google.com",
      "app-measurement.com",
      "analytics.google.com",
      "*.umeng.com",
      "*.umengcloud.com",
      "*.open.e.kuaishou.com",
      "*.ad.xiaomi.com",
      "*.sensorsdata.cn",
      "*.talkingdata.net",
      "*.growingio.com",
      "*.trackingio.com",
      "log.byteoversea.com",
      "*.data.bilibili.com"
    ],
    ips: [],
    packages: [
      "com.ss.android.*",
      "com.smile.gifmaker",
      "com.kuaishou.nebula",
      "com.xunmeng.pinduoduo",
      "pinduoduo.exe",
      "com.tencent.tmgp.*",
      "com.miui.analytics",
      "com.vivo.pushservice"
    ]
  },
  {
    id: "none",
    name: "直通无拦截 (None)",
    description: "不执行任何自定义 reject 规则，所有流量按基础分流直连或代理",
    domains: [],
    ips: [],
    packages: []
  }
];

async function resolveRejectRules(env, subInfo) {
  const profileId = subInfo.ruleProfileId || "default";
  let profileRules = { domains: [], ips: [], packages: [] };

  if (profileId === "none") {
    profileRules = { domains: [], ips: [], packages: [] };
  } else {
    let raw = null;
    if (env && env.SUB_KV) {
      try {
        raw = await env.SUB_KV.get("rule_profile:" + profileId);
      } catch (e) {}
    }
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        profileRules = {
          domains: obj.domains || [],
          ips: obj.ips || [],
          packages: obj.packages || []
        };
      } catch (e) {}
    } else {
      const def = DEFAULT_RULE_PROFILES.find(p => p.id === profileId) || DEFAULT_RULE_PROFILES[0];
      profileRules = {
        domains: def.domains || [],
        ips: def.ips || [],
        packages: def.packages || []
      };
    }
  }

  // 如果订阅自身还定义了额外/覆盖规则 (rejectRules)，则合并生效
  const extra = subInfo.rejectRules || {};
  const mergedDomains = [...(profileRules.domains || []), ...(extra.domains || [])];
  const mergedIps = [...(profileRules.ips || []), ...(extra.ips || [])];
  const mergedPackages = [...(profileRules.packages || []), ...(extra.packages || [])];

  return {
    domains: mergedDomains,
    ips: mergedIps,
    packages: mergedPackages
  };
}

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

  const targetVersion = url.searchParams.get("version") || subInfo.targetVersion || "1.15";
  const enableTun = url.searchParams.get("tun") !== null
    ? url.searchParams.get("tun") !== "false"
    : (subInfo.enableTun !== false);

  const rejectRules = await resolveRejectRules(env, subInfo);

  const subIdParam = subId;
  return convertFromUrl(subInfo.sourceUrl, { targetVersion, enableTun, rejectRules, env, subId: subIdParam });
}

async function convertFromUrl(sourceUrl, options = {}) {
  const targetVersion = options.targetVersion || "1.15";
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
    "User-Agent": "sing-box/1.15.0; clash.meta; Mozilla/5.0",
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

function generateSingBoxConfig(nodes, { targetVersion = "1.15", enableTun = true, rejectRules = {} }) {
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
    listen: "0.0.0.0",
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
    // 拦截 QUIC (UDP 443)，促使 Chrome/浏览器无感平滑回退到稳定的 TCP HTTP/2，彻底根除 YouTube 掉区与 Gemini 地区不支持问题
    {
      action: "reject",
      network: "udp",
      port: [443]
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

  // --- 自定义拒绝拦截规则 (DNS & Route) ---
  // 支持域名、IP/CIDR、Android 应用包名（支持 * 通配符，自动转为 package_name_regex）及桌面进程名（.exe）
  // 即使在用户界面或配置中将包名与域名放置在一起，也会智能识别分流并生成独立的 Sing-box 路由规则，避免逻辑与（AND）导致失效
  const domainSuffixSet = new Set();
  const domainExactSet = new Set();
  const domainRegexSet = new Set();
  const ipCidrSet = new Set();
  const exactPackageSet = new Set();
  const wildcardPackageRegexSet = new Set();
  const exactProcessSet = new Set();
  const wildcardProcessRegexSet = new Set();

  function wildcardToRegex(p) {
    return "^" + p.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  }

  function addRejectItem(rawItem) {
    if (!rawItem) return;
    const item = String(rawItem).trim();
    if (!item) return;
    const lower = item.toLowerCase();

    // 1. IP / CIDR 识别 (如 1.2.3.4, 192.168.1.0/24, 2001:db8::/32)
    if (/^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/.test(item) || /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(\/\d{1,3})?$/.test(item)) {
      ipCidrSet.add(item.includes("/") ? item : item + (item.includes(":") ? "/128" : "/32"));
      return;
    }

    // 2. 桌面进程名识别 (以 .exe 结尾或包含 .exe)
    if (lower.endsWith(".exe") || lower.includes(".exe")) {
      if (item.includes("*")) {
        wildcardProcessRegexSet.add(wildcardToRegex(item));
      } else {
        exactProcessSet.add(item);
      }
      return;
    }

    // 3. Android 应用包名识别
    // 包名特点：以 com., org., net., io., cn., tv., me., android., app. 开头，包含点，且不以常见域名后缀 (.com, .cn 等) 结尾
    const isDomainTld = /\.(com|cn|net|org|io|me|xyz|top|site|cc|info|app|co|de|uk|jp|ru|us|hk|tw|sg|biz|tv|gov|edu)(\.[a-z]{2})?$/i.test(item);
    const looksLikePackage = /^(com|org|net|io|cn|tv|me|android|app)\.[a-zA-Z0-9_.*]+$/.test(item);

    if (looksLikePackage && !isDomainTld) {
      if (item.includes("*")) {
        // 通配符自动转换为正则，例如: com.ss.android.* -> ^com\.ss\.android\..*$
        wildcardPackageRegexSet.add(wildcardToRegex(item));
      } else {
        exactPackageSet.add(item);
      }
      return;
    }

    // 4. 域名识别与处理 (支持 *.domain.com, .domain.com, domain.com, 以及含 * 的正则表达式)
    let clean = item;
    if (clean.startsWith("*.")) clean = clean.substring(2);
    else if (clean.startsWith(".")) clean = clean.substring(1);

    if (clean.includes("*")) {
      // 内部含通配符的域名 (如 ad*.google.com)
      domainRegexSet.add(wildcardToRegex(clean));
    } else if (clean) {
      domainSuffixSet.add(clean.toLowerCase());
      domainExactSet.add(clean.toLowerCase());
    }
  }

  // 接收并解构用户规则输入（无论分别输入还是混杂输入，均会自动分类）
  const parseRawArr = (arr) => {
    if (!arr) return;
    const list = Array.isArray(arr) ? arr : [arr];
    list.forEach(val => {
      String(val).replace(/\\n/g, "\n").split(/[\s,\r\n]+/).forEach(s => {
        if (s.trim()) addRejectItem(s.trim());
      });
    });
  };

  parseRawArr(rejectRules.domains);
  parseRawArr(rejectRules.ips);
  parseRawArr(rejectRules.packages);

  // 1. 生成域名拒绝规则 (DNS & Route)
  if (domainSuffixSet.size > 0 || domainExactSet.size > 0 || domainRegexSet.size > 0) {
    const dRuleDns = { action: "reject" };
    const dRuleRoute = { action: "reject" };
    if (domainSuffixSet.size > 0) {
      dRuleDns.domain_suffix = Array.from(domainSuffixSet);
      dRuleRoute.domain_suffix = Array.from(domainSuffixSet);
    }
    if (domainExactSet.size > 0) {
      dRuleDns.domain = Array.from(domainExactSet);
      dRuleRoute.domain = Array.from(domainExactSet);
    }
    if (domainRegexSet.size > 0) {
      dRuleDns.domain_regex = Array.from(domainRegexSet);
      dRuleRoute.domain_regex = Array.from(domainRegexSet);
    }
    dnsRules.push(dRuleDns);
    routeRules.push(dRuleRoute);
  }

  // 2. 生成 IP / CIDR 拒绝规则 (Route)
  if (ipCidrSet.size > 0) {
    routeRules.push({ action: "reject", ip_cidr: Array.from(ipCidrSet) });
  }

  // 3. 生成 Android 包名拒绝规则 (Route)
  if (exactPackageSet.size > 0) {
    routeRules.push({ action: "reject", package_name: Array.from(exactPackageSet) });
  }
  if (wildcardPackageRegexSet.size > 0) {
    routeRules.push({ action: "reject", package_name_regex: Array.from(wildcardPackageRegexSet) });
  }

  // 4. 生成 桌面进程名 拒绝规则 (Route)
  if (exactProcessSet.size > 0) {
    routeRules.push({ action: "reject", process_name: Array.from(exactProcessSet) });
  }
  if (wildcardProcessRegexSet.size > 0) {
    routeRules.push({ action: "reject", process_path_regex: Array.from(wildcardProcessRegexSet) });
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
        external_controller: "0.0.0.0:9090",
        external_ui: "ui",
        external_ui_download_url: "https://github.com/MetaCubeX/metacubexd/archive/refs/heads/gh-pages.zip",
        external_ui_download_detour: "proxy",
        secret: "",
        default_mode: "Rule"
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
    targetVersion: body.targetVersion || "1.15",
    enableTun: body.enableTun !== false,
    ruleProfileId: body.ruleProfileId || "default",
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
    targetVersion: body.targetVersion || prev.targetVersion || "1.15",
    enableTun: body.enableTun !== undefined ? body.enableTun : prev.enableTun,
    ruleProfileId: body.ruleProfileId !== undefined ? body.ruleProfileId : (prev.ruleProfileId || "default"),
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

// ---- 规则配置文件 (Rule Profiles) API ----

async function handleApiRuleProfilesList(request, env, corsHeaders) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({ error: "SUB_KV not bound" }), { status: 500, headers: corsHeaders });
  }
  const list = await env.SUB_KV.list({ prefix: "rule_profile:" });
  const items = [];
  const foundIds = new Set();

  for (let key of list.keys) {
    const raw = await env.SUB_KV.get(key.name);
    if (raw) {
      try {
        const obj = JSON.parse(raw);
        const id = key.name.replace("rule_profile:", "");
        items.push({ id, ...obj });
        foundIds.add(id);
      } catch (e) {}
    }
  }

  // 确保系统预置模板存在
  for (let def of DEFAULT_RULE_PROFILES) {
    if (!foundIds.has(def.id)) {
      items.push({ ...def, updatedAt: new Date().toISOString() });
      try {
        await env.SUB_KV.put("rule_profile:" + def.id, JSON.stringify(def));
      } catch (e) {}
    }
  }

  return new Response(JSON.stringify({ items }), {
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
  });
}

async function handleApiRuleProfilesCreate(request, env, corsHeaders) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({ error: "SUB_KV not bound" }), { status: 500, headers: corsHeaders });
  }
  const body = await request.json();
  const id = (body.id || "rule_" + Math.random().toString(36).substring(2, 8)).trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!id) {
    return new Response(JSON.stringify({ error: "规则配置 ID 格式无效" }), { status: 400, headers: corsHeaders });
  }

  const existing = await env.SUB_KV.get("rule_profile:" + id);
  if (existing) {
    return new Response(JSON.stringify({ error: "该规则配置 ID 已存在，请更换" }), { status: 400, headers: corsHeaders });
  }

  const data = {
    id,
    name: (body.name || "自定义规则配置").trim(),
    description: (body.description || "").trim(),
    domains: parseInputList(body.domains),
    ips: parseInputList(body.ips),
    packages: parseInputList(body.packages),
    updatedAt: new Date().toISOString()
  };

  await env.SUB_KV.put("rule_profile:" + id, JSON.stringify(data));
  return new Response(JSON.stringify({ success: true, id, data }), { headers: corsHeaders });
}

async function handleApiRuleProfilesUpdate(request, env, corsHeaders) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({ error: "SUB_KV not bound" }), { status: 500, headers: corsHeaders });
  }
  const body = await request.json();
  const id = (body.id || "").trim();
  if (!id) {
    return new Response(JSON.stringify({ error: "缺少规则配置 ID" }), { status: 400, headers: corsHeaders });
  }

  let prev = {};
  const existing = await env.SUB_KV.get("rule_profile:" + id);
  if (existing) {
    try { prev = JSON.parse(existing); } catch (e) {}
  } else {
    const foundDef = DEFAULT_RULE_PROFILES.find(p => p.id === id);
    if (foundDef) prev = { ...foundDef };
  }

  const data = {
    ...prev,
    id,
    name: body.name ? body.name.trim() : (prev.name || "自定义规则配置"),
    description: body.description !== undefined ? body.description.trim() : (prev.description || ""),
    domains: body.domains !== undefined ? parseInputList(body.domains) : (prev.domains || []),
    ips: body.ips !== undefined ? parseInputList(body.ips) : (prev.ips || []),
    packages: body.packages !== undefined ? parseInputList(body.packages) : (prev.packages || []),
    updatedAt: new Date().toISOString()
  };

  await env.SUB_KV.put("rule_profile:" + id, JSON.stringify(data));
  return new Response(JSON.stringify({ success: true, id, data }), { headers: corsHeaders });
}

async function handleApiRuleProfilesDelete(request, env, corsHeaders) {
  if (!env.SUB_KV) {
    return new Response(JSON.stringify({ error: "SUB_KV not bound" }), { status: 500, headers: corsHeaders });
  }
  const body = await request.json();
  const id = (body.id || "").trim();
  if (!id) {
    return new Response(JSON.stringify({ error: "缺少规则配置 ID" }), { status: 400, headers: corsHeaders });
  }
  if (id === "none" || id === "default") {
    return new Response(JSON.stringify({ error: "系统基础预置规则配置不可删除" }), { status: 400, headers: corsHeaders });
  }

  await env.SUB_KV.delete("rule_profile:" + id);
  return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
}

function parseInputList(val) {
  if (!val) return [];
  if (Array.isArray(val)) {
    return val.flatMap(s => String(s).replace(/\\n/g, "\n").split(/[\s,\r\n]+/)).map(s => s.trim()).filter(Boolean);
  }
  return String(val).replace(/\\n/g, "\n").split(/[\s,\r\n]+/).map(s => s.trim()).filter(Boolean);
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
      --primary: #38bdf8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 28px 16px; min-height: 100vh; display: flex; justify-content: center; }
    .container { width: 100%; max-width: 920px; }
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
    .btn { background: var(--accent); color: #000; font-weight: 600; padding: 10px 20px; border: none; border-radius: 6px; cursor: pointer; transition: 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
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

    .sub-item, .profile-item { background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 14px; display: flex; flex-direction: column; gap: 10px; }
    .sub-header { display: flex; justify-content: space-between; align-items: center; }
    .sub-title { font-weight: 600; font-size: 16px; color: var(--accent); }
    .sub-url { word-break: break-all; font-family: monospace; font-size: 12px; color: #38bdf8; background: #1e293b; padding: 8px 12px; border-radius: 4px; display: flex; justify-content: space-between; align-items: center; }
    .copy-btn { cursor: pointer; color: var(--accent); margin-left: 10px; font-weight: 500; }
    .copy-btn:hover { text-decoration: underline; }
    .meta-tag { font-size: 12px; color: var(--text-muted); word-break: break-all; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #334155; color: #94a3b8; margin-right: 6px; }
    .badge-reject { background: #7f1d1d; color: #fca5a5; }
    .badge-profile { background: #1e3a8a; color: #93c5fd; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>⚡ Sing-box 订阅托管转换中心</h1>
      <p>Cloudflare 边缘极速生成 · KV 永久联动更新 · 规则配置文件中心化管理 · 局域网共享代理 (0.0.0.0:2080)</p>
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
            <option value="1.15" selected>Sing-box 1.15+ (稳定标准版，支持 FakeIP / 原生 TUN)</option>
          </select>
        </div>
      </div>

      <!-- 关联规则配置文件 -->
      <div class="form-group">
        <label>🛡️ 关联拒绝拦截规则配置文件</label>
        <select id="subRuleProfile" onchange="onRuleProfileChange('sub')">
          <option value="">加载中...</option>
        </select>
        <div id="subProfileDesc" style="font-size: 12px; color: #38bdf8; margin-top: 6px;"></div>
      </div>

      <!-- 可选高级独立自定义覆盖 -->
      <details style="margin-bottom: 16px; background: #131d2e; border: 1px solid #1e3a5f; border-radius: 8px; padding: 12px 16px;">
        <summary style="color: #94a3b8; cursor: pointer; font-size: 13px; font-weight: 500;">
          ⚙️ 针对此订阅单独追加专属规则 (可选，留空则完全以所选配置文件为准) ▾
        </summary>
        <div class="grid-3" style="margin-top: 12px;">
          <div class="form-group" style="margin-bottom:0;">
            <label>追加拒绝域名<span class="label-hint">每行一个</span></label>
            <textarea id="rejectDomains" rows="4" placeholder="例如:&#10;*.ad.example.com"></textarea>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label>追加拒绝 IP/CIDR<span class="label-hint">每行一个</span></label>
            <textarea id="rejectIps" rows="4" placeholder="例如:&#10;123.56.78.90/32"></textarea>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label>追加拒绝包名/进程<span class="label-hint">支持 * 通配符</span></label>
            <textarea id="rejectPackages" rows="4" placeholder="例如:&#10;com.bad.app.*&#10;bad.exe"></textarea>
          </div>
        </div>
      </details>

      <button class="btn" onclick="createSub()">⚡ 生成永久专属订阅地址</button>
    </div>

    <!-- 规则配置文件管理 -->
    <div class="card">
      <h2>
        <span>🛡️ 拒绝拦截规则配置文件 (Rule Profiles)</span>
        <button class="btn btn-sm" onclick="openCreateRuleProfile()">➕ 新建规则配置</button>
      </h2>
      <div id="ruleProfileList">正在读取规则配置...</div>
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

  <!-- 编辑订阅弹窗 -->
  <div id="editModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:999;align-items:center;justify-content:center;">
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px;width:100%;max-width:640px;max-height:90vh;overflow-y:auto;position:relative;">
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
          <option value="1.15" selected>Sing-box 1.15+</option>
        </select>
      </div>

      <div class="form-group">
        <label>🛡️ 关联拒绝拦截规则配置文件</label>
        <select id="editRuleProfile" onchange="onRuleProfileChange('edit')"></select>
        <div id="editProfileDesc" style="font-size: 12px; color: #38bdf8; margin-top: 6px;"></div>
      </div>

      <details style="margin-bottom: 16px; background: #131d2e; border: 1px solid #1e3a5f; border-radius: 8px; padding: 12px 16px;">
        <summary style="color: #94a3b8; cursor: pointer; font-size: 13px; font-weight: 500;">
          ⚙️ 单独追加专属规则 (可选覆盖) ▾
        </summary>
        <div class="grid-3" style="margin-top: 12px;">
          <div class="form-group" style="margin-bottom:0;">
            <label>追加域名<span class="label-hint">每行一个</span></label>
            <textarea id="editRejectDomains" rows="4"></textarea>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label>追加 IP/CIDR<span class="label-hint">每行一个</span></label>
            <textarea id="editRejectIps" rows="4"></textarea>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label>追加包名/进程<span class="label-hint">支持 * 通配符</span></label>
            <textarea id="editRejectPackages" rows="4"></textarea>
          </div>
        </div>
      </details>

      <div style="display:flex;gap:12px;margin-top:12px;">
        <button id="editSaveBtn" class="btn" onclick="saveEdit()">💾 保存</button>
        <button class="btn btn-secondary" onclick="closeEdit()">取消</button>
      </div>
    </div>
  </div>

  <!-- 规则配置文件编辑/创建弹窗 -->
  <div id="ruleProfileModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:1000;align-items:center;justify-content:center;">
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px;width:100%;max-width:700px;max-height:92vh;overflow-y:auto;position:relative;">
      <h2 style="font-size:18px;margin-bottom:20px;color:#38bdf8;" id="rpmTitle">🛡️ 规则配置文件</h2>
      
      <div class="grid-2">
        <div class="form-group">
          <label>配置 ID <span class="label-hint">(小写字母/数字/下划线)</span></label>
          <input type="text" id="rpmId" placeholder="例如: work_clean">
        </div>
        <div class="form-group">
          <label>配置名称</label>
          <input type="text" id="rpmName" placeholder="例如: 办公深度防干扰">
        </div>
      </div>

      <div class="form-group">
        <label>说明备注</label>
        <input type="text" id="rpmDesc" placeholder="简述该规则配置的应用场景与目标">
      </div>

      <div class="rules-section">
        <div class="rules-header">🛡️ 规则拦截清单 (自动智能识别分流；包名支持 * 通配符)</div>
        <div class="grid-3">
          <div class="form-group" style="margin-bottom:0;">
            <label>拒绝域名 (Domain / Suffix)<span class="label-hint">支持 *. 前缀</span></label>
            <textarea id="rpmDomains" rows="8" placeholder="*.pangolin-sdk-toutiao.com&#10;adservice.google.com"></textarea>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label>拒绝 IP / CIDR<span class="label-hint">每行一个</span></label>
            <textarea id="rpmIps" rows="8" placeholder="123.56.78.90/32"></textarea>
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label>拒绝包名 / 进程<span class="label-hint">支持 * 通配符与 .exe</span></label>
            <textarea id="rpmPackages" rows="8" placeholder="com.ss.android.*&#10;pinduoduo.exe"></textarea>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:12px;margin-top:16px;">
        <button id="rpmSaveBtn" class="btn" onclick="saveRuleProfile()">💾 保存规则配置</button>
        <button class="btn btn-secondary" onclick="closeRuleProfileModal()">取消</button>
      </div>
    </div>
  </div>

  <script>
    const origin = window.location.origin;
    let _ruleProfiles = [];
    let _editingSubId = null;
    let _isEditingProfile = false;

    // ---- 规则配置文件加载与管理 ----

    async function loadRuleProfiles() {
      const container = document.getElementById('ruleProfileList');
      try {
        const res = await fetch('/api/rule_profiles/list');
        const data = await res.json();
        _ruleProfiles = data.items || [];
        renderRuleProfilesList();
        populateProfileDropdowns();
      } catch (e) {
        container.innerHTML = '<div style="color: #f87171;">加载规则配置失败: ' + e.message + '</div>';
      }
    }

    function renderRuleProfilesList() {
      const container = document.getElementById('ruleProfileList');
      if (!_ruleProfiles || _ruleProfiles.length === 0) {
        container.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 16px;">暂无规则配置文件</div>';
        return;
      }
      container.innerHTML = '';
      _ruleProfiles.forEach(p => {
        const domainCount = (p.domains || []).length;
        const ipCount = (p.ips || []).length;
        const pkgCount = (p.packages || []).length;

        const isSystem = (p.id === 'none' || p.id === 'default');
        const div = document.createElement('div');
        div.className = 'profile-item';
        div.innerHTML =
          '<div class="sub-header">' +
            '<div>' +
              '<span class="sub-title" style="color: #38bdf8;">' + (p.name || p.id) + '</span> ' +
              '<span class="badge">ID: ' + p.id + '</span> ' +
              '<span class="badge badge-profile">' + domainCount + ' 域名</span> ' +
              '<span class="badge badge-profile">' + pkgCount + ' 包名/进程</span> ' +
              (ipCount ? '<span class="badge badge-profile">' + ipCount + ' IP</span> ' : '') +
            '</div>' +
            '<div style="display:flex;gap:6px;">' +
              '<button class="btn btn-sm btn-secondary btn-edit-rp" data-id="' + p.id + '">✏️ 编辑规则</button>' +
              (!isSystem ? '<button class="btn btn-sm btn-danger btn-del-rp" data-id="' + p.id + '">删除</button>' : '') +
            '</div>' +
          '</div>' +
          '<div class="meta-tag">' + (p.description || '无描述说明') + '</div>';

        div.querySelector('.btn-edit-rp').addEventListener('click', () => editRuleProfile(p.id));
        const delBtn = div.querySelector('.btn-del-rp');
        if (delBtn) delBtn.addEventListener('click', () => deleteRuleProfile(p.id));

        container.appendChild(div);
      });
    }

    function populateProfileDropdowns() {
      const subSel = document.getElementById('subRuleProfile');
      const editSel = document.getElementById('editRuleProfile');
      let html = '';
      _ruleProfiles.forEach(p => {
        const countStr = ((p.domains||[]).length + (p.packages||[]).length) > 0 ? (' (' + (p.domains||[]).length + ' 域名, ' + (p.packages||[]).length + ' 包名)') : ' (无拦截)';
        html += '<option value="' + p.id + '">' + p.name + countStr + '</option>';
      });
      subSel.innerHTML = html;
      editSel.innerHTML = html;
      subSel.value = 'default';
      onRuleProfileChange('sub');
    }

    function onRuleProfileChange(target) {
      const sel = document.getElementById(target === 'edit' ? 'editRuleProfile' : 'subRuleProfile');
      const descEl = document.getElementById(target === 'edit' ? 'editProfileDesc' : 'subProfileDesc');
      const p = _ruleProfiles.find(i => i.id === sel.value);
      if (p) {
        descEl.textContent = '💡 ' + (p.description || '已关联该规则配置文件');
      } else {
        descEl.textContent = '';
      }
    }

    function openCreateRuleProfile() {
      _isEditingProfile = false;
      document.getElementById('rpmTitle').textContent = '➕ 新建规则配置文件';
      document.getElementById('rpmId').value = '';
      document.getElementById('rpmId').disabled = false;
      document.getElementById('rpmName').value = '';
      document.getElementById('rpmDesc').value = '';
      document.getElementById('rpmDomains').value = '';
      document.getElementById('rpmIps').value = '';
      document.getElementById('rpmPackages').value = '';
      document.getElementById('ruleProfileModal').style.display = 'flex';
    }

    function editRuleProfile(id) {
      const p = _ruleProfiles.find(i => i.id === id);
      if (!p) return;
      _isEditingProfile = true;
      document.getElementById('rpmTitle').textContent = '✏️ 编辑规则配置文件: ' + (p.name || id);
      document.getElementById('rpmId').value = p.id;
      document.getElementById('rpmId').disabled = true;
      document.getElementById('rpmName').value = p.name || '';
      document.getElementById('rpmDesc').value = p.description || '';
      document.getElementById('rpmDomains').value = (p.domains || []).join('\\n');
      document.getElementById('rpmIps').value = (p.ips || []).join('\\n');
      document.getElementById('rpmPackages').value = (p.packages || []).join('\\n');
      document.getElementById('ruleProfileModal').style.display = 'flex';
    }

    function closeRuleProfileModal() {
      document.getElementById('ruleProfileModal').style.display = 'none';
    }

    async function saveRuleProfile() {
      const btn = document.getElementById('rpmSaveBtn');
      const id = document.getElementById('rpmId').value.trim();
      const name = document.getElementById('rpmName').value.trim();
      const description = document.getElementById('rpmDesc').value.trim();
      const domains = document.getElementById('rpmDomains').value;
      const ips = document.getElementById('rpmIps').value;
      const packages = document.getElementById('rpmPackages').value;

      if (!id) { alert('请输入规则配置 ID'); return; }
      if (!name) { alert('请输入规则配置名称'); return; }

      btn.disabled = true;
      btn.textContent = '保存中...';

      try {
        const endpoint = _isEditingProfile ? '/api/rule_profiles/update' : '/api/rule_profiles/create';
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, name, description, domains, ips, packages })
        });
        const ret = await res.json();
        if (ret.success) {
          closeRuleProfileModal();
          await loadRuleProfiles();
          loadSubs();
          alert('✅ 规则配置文件保存成功！所有关联此配置的订阅均已自动更新生效。');
        } else {
          alert('保存失败: ' + (ret.error || '未知错误'));
        }
      } catch (e) {
        alert('保存异常: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '💾 保存规则配置';
      }
    }

    async function deleteRuleProfile(id) {
      if (!confirm('确定要删除规则配置 [' + id + '] 吗？')) return;
      try {
        const res = await fetch('/api/rule_profiles/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const ret = await res.json();
        if (ret.success) {
          await loadRuleProfiles();
          alert('已删除该规则配置');
        } else {
          alert('删除失败: ' + (ret.error || '未知错误'));
        }
      } catch (e) {
        alert('删除异常: ' + e.message);
      }
    }

    // ---- 订阅列表与管理 ----

    async function loadSubs() {
      const container = document.getElementById('subList');
      container.innerHTML = '正在读取订阅数据...';
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
          const pid = item.ruleProfileId || 'default';
          const p = _ruleProfiles.find(i => i.id === pid);
          const pName = p ? p.name : pid;

          const rules = item.rejectRules || {};
          const extraCount = (rules.domains||[]).length + (rules.ips||[]).length + (rules.packages||[]).length;
          const extraBadge = extraCount > 0 ? ('<span class="badge" style="background:#0284c7;color:#fff;">+额外规则 (' + extraCount + ')</span> ') : '';

          const div = document.createElement('div');
          div.className = 'sub-item';
          div.id = 'sub-item-' + item.id;
          div.innerHTML =
            '<div class="sub-header">' +
              '<div>' +
                '<span class="sub-title">' + (item.name || '未命名') + '</span> ' +
                '<span class="badge">ID: ' + item.id + '</span> ' +
                '<span class="badge">v' + (item.targetVersion || '1.15') + '</span> ' +
                '<span class="badge badge-reject">🛡️ 规则配置: ' + pName + '</span> ' +
                extraBadge +
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
      const targetVersion = document.getElementById('targetVersion').value || '1.15';
      const ruleProfileId = document.getElementById('subRuleProfile').value || 'default';
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
          body: JSON.stringify({ name, sourceUrl, id, targetVersion, ruleProfileId, rejectDomains, rejectIps, rejectPackages })
        });
        const ret = await res.json();
        if (ret.success) {
          const fileMsg = ret.filePath ? ('\\n\\n📁 本地文件已生成保存：\\n' + ret.filePath + '\\n(后台关闭后此文件不会自动删除，可长期用于调试)') : '';
          alert('🎉 创建成功！专属订阅地址已生成并绑定。' + fileMsg);
          document.getElementById('sourceUrl').value = '';
          document.getElementById('subId').value = '';
          document.getElementById('rejectDomains').value = '';
          document.getElementById('rejectIps').value = '';
          document.getElementById('rejectPackages').value = '';
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

    async function editSub(id) {
      const res = await fetch('/api/list');
      const data = await res.json();
      const item = (data.items || []).find(i => i.id === id);
      if (!item) { alert('未找到订阅'); return; }

      _editingSubId = id;
      const rules = item.rejectRules || {};
      document.getElementById('editId').textContent = id;
      document.getElementById('editName').value = item.name || '';
      document.getElementById('editSourceUrl').value = item.sourceUrl || '';
      document.getElementById('editTargetVersion').value = item.targetVersion || '1.15';
      document.getElementById('editRuleProfile').value = item.ruleProfileId || 'default';
      onRuleProfileChange('edit');
      document.getElementById('editRejectDomains').value = (rules.domains || []).join('\\n');
      document.getElementById('editRejectIps').value = (rules.ips || []).join('\\n');
      document.getElementById('editRejectPackages').value = (rules.packages || []).join('\\n');
      document.getElementById('editModal').style.display = 'flex';
    }

    function closeEdit() {
      document.getElementById('editModal').style.display = 'none';
      _editingSubId = null;
    }

    async function saveEdit() {
      if (!_editingSubId) return;
      const btn = document.getElementById('editSaveBtn');
      btn.disabled = true;
      btn.textContent = '保存中...';
      try {
        const res = await fetch('/api/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: _editingSubId,
            name: document.getElementById('editName').value.trim(),
            sourceUrl: document.getElementById('editSourceUrl').value.trim(),
            targetVersion: document.getElementById('editTargetVersion').value || '1.15',
            ruleProfileId: document.getElementById('editRuleProfile').value || 'default',
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
      } catch (e) {
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

    // 初始化加载
    loadRuleProfiles().then(() => loadSubs());
  </script>
</body>
</html>`;
}