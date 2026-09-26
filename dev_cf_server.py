import http.server
import socketserver
import json
import os
import sys
import subprocess
import tempfile
import signal
import urllib.parse
import re
from datetime import datetime, timezone

PORT = 8787
socketserver.TCPServer.allow_reuse_address = True

# Windows 控制台关闭事件捕获，确保窗口一关立即自杀并释放端口
if sys.platform == "win32":
    import ctypes
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    def console_ctrl_handler(ctrl_type):
        # 0: CTRL_C_EVENT, 2: CTRL_CLOSE_EVENT, 5: CTRL_LOGOFF_EVENT, 6: CTRL_SHUTDOWN_EVENT
        os._exit(0)
    handler_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_uint)
    _win_handler = handler_type(console_ctrl_handler)
    ctypes.windll.kernel32.SetConsoleCtrlHandler(_win_handler, True)

TEMP_DIR = tempfile.gettempdir()
LOCAL_DATA_DIR = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or TEMP_DIR
KV_STORE_FILE = os.path.join(LOCAL_DATA_DIR, "singbox_converter_dev_kv.json")

mock_kv = {}

def save_kv_to_disk():
    try:
        with open(KV_STORE_FILE, "w", encoding="utf-8") as f:
            json.dump(mock_kv, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"[Warn] 保存 KV 存储文件失败: {e}")

def parse_input_list(val):
    if not val:
        return []
    if isinstance(val, list):
        items = []
        for x in val:
            items.extend(parse_input_list(x))
        return items
    raw = str(val).replace("\\n", "\n")
    tokens = re.split(r"[\s,\r\n]+", raw)
    return [t.strip() for t in tokens if t.strip()]

DEFAULT_RULE_PROFILES = {
    "rule_profile:default": json.dumps({
        "id": "default",
        "name": "默认基础拦截 (广告SDK / 追踪 / 短视频)",
        "description": "拦截主流广告追踪联盟、开屏SDK及短视频后台数据同步",
        "domains": [
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
        "ips": [],
        "packages": [
            "com.ss.android.*",
            "com.smile.gifmaker",
            "com.kuaishou.nebula",
            "com.xunmeng.pinduoduo",
            "pinduoduo.exe"
        ],
        "updatedAt": "2026-09-26T10:00:00.000Z"
    }, ensure_ascii=False),
    "rule_profile:strict": json.dumps({
        "id": "strict",
        "name": "强力隐私防护 (含大数据埋点与厂商遥测)",
        "description": "在默认规则基础上，额外拦截设备指纹收集、用户行为埋点上报及国内厂商遥测",
        "domains": [
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
        "ips": [],
        "packages": [
            "com.ss.android.*",
            "com.smile.gifmaker",
            "com.kuaishou.nebula",
            "com.xunmeng.pinduoduo",
            "pinduoduo.exe",
            "com.tencent.tmgp.*",
            "com.miui.analytics",
            "com.vivo.pushservice"
        ],
        "updatedAt": "2026-09-26T10:00:00.000Z"
    }, ensure_ascii=False),
    "rule_profile:none": json.dumps({
        "id": "none",
        "name": "直通无拦截 (None)",
        "description": "不执行任何自定义 reject 规则，所有流量按基础分流直连或代理",
        "domains": [],
        "ips": [],
        "packages": [],
        "updatedAt": "2026-09-26T10:00:00.000Z"
    }, ensure_ascii=False)
}

def resolve_sub_rules(sub_info):
    pid = sub_info.get("ruleProfileId", "default")
    domains = []
    ips = []
    packages = []
    if pid != "none":
        praw = mock_kv.get(f"rule_profile:{pid}")
        if praw:
            try:
                pobj = json.loads(praw)
                domains = list(pobj.get("domains", []))
                ips = list(pobj.get("ips", []))
                packages = list(pobj.get("packages", []))
            except Exception:
                pass
        else:
            praw = DEFAULT_RULE_PROFILES.get("rule_profile:default")
            if praw:
                try:
                    pobj = json.loads(praw)
                    domains = list(pobj.get("domains", []))
                    ips = list(pobj.get("ips", []))
                    packages = list(pobj.get("packages", []))
                except Exception:
                    pass
    # 合并订阅内可能单独指定的规则
    extra = sub_info.get("rejectRules", {})
    domains.extend(extra.get("domains", []))
    ips.extend(extra.get("ips", []))
    packages.extend(extra.get("packages", []))
    return {
        "domains": [d for d in domains if d],
        "ips": [i for i in ips if i],
        "packages": [p for p in packages if p]
    }

def load_kv_from_disk():
    global mock_kv
    old_file = os.path.join(r"z:\SingBoxConvertor", "dev_kv_store.json")
    if os.path.exists(old_file) and not os.path.exists(KV_STORE_FILE):
        try:
            import shutil
            shutil.copyfile(old_file, KV_STORE_FILE)
            os.remove(old_file)
            print(f"[迁移] 已将 KV 存储文件移出项目目录至安全用户区: {KV_STORE_FILE}")
        except Exception as me:
            print(f"[Warn] 迁移旧 KV 存储失败: {me}")
    elif os.path.exists(old_file) and os.path.exists(KV_STORE_FILE):
        try:
            os.remove(old_file)
        except Exception:
            pass

    if os.path.exists(KV_STORE_FILE):
        try:
            with open(KV_STORE_FILE, "r", encoding="utf-8") as f:
                mock_kv = json.load(f)
                if mock_kv:
                    updated = False
                    for rk, rv in DEFAULT_RULE_PROFILES.items():
                        if rk not in mock_kv:
                            mock_kv[rk] = rv
                            updated = True
                    for k, v in list(mock_kv.items()):
                        if k.startswith("sub:"):
                            try:
                                obj = json.loads(v)
                                if "ruleProfileId" not in obj:
                                    obj["ruleProfileId"] = "default"
                                    updated = True
                                if obj.get("targetVersion") == "1.14":
                                    obj["targetVersion"] = "1.15"
                                    updated = True
                                mock_kv[k] = json.dumps(obj, ensure_ascii=False)
                            except Exception:
                                pass
                    if updated:
                        save_kv_to_disk()
                    return
        except Exception:
            pass

    # 初始默认数据
    mock_kv = {
        **DEFAULT_RULE_PROFILES,
        "sub:99": json.dumps({
            "sourceUrl": "https://js.ebox.de5.net/jsh/sub?target=clash",
            "name": "主力机场 (99)",
            "targetVersion": "1.15",
            "enableTun": True,
            "ruleProfileId": "default",
            "rejectRules": {"domains": [], "ips": [], "packages": []},
            "updatedAt": "2026-09-26T03:13:00.000Z"
        }, ensure_ascii=False),
        "sub:sample-sub": json.dumps({
            "sourceUrl": "https://example.com/api/v1/client/subscribe?token=demo_token",
            "name": "示例主力机场 (含拦截规则)",
            "targetVersion": "1.15",
            "enableTun": True,
            "ruleProfileId": "default",
            "rejectRules": {"domains": [], "ips": [], "packages": []},
            "updatedAt": "2026-09-26T06:30:00.000Z"
        }, ensure_ascii=False)
    }
    save_kv_to_disk()

load_kv_from_disk()

def run_conversion_and_save(sub_id, sub_info):
    source_url = sub_info.get("sourceUrl")
    temp_filepath = os.path.join(TEMP_DIR, f"singbox_{sub_id}.json")
    if not source_url:
        return None, temp_filepath, "缺少 sourceUrl"
    try:
        node_script = """
import fs from 'fs';
import vm from 'vm';

const input = JSON.parse(fs.readFileSync(0, 'utf-8'));
const content = fs.readFileSync('src/index.js', 'utf8');

const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    Headers,
    Request,
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    URL,
    Response: class { constructor(b, i) { this.body = b; this.init = i; } },
    fetch: globalThis.fetch
};

vm.createContext(sandbox);
vm.runInContext(content.replace('export default {', 'const handler = {'), sandbox);

sandbox.convertFromUrl(input.sourceUrl, {
    targetVersion: input.targetVersion || "1.15",
    enableTun: input.enableTun !== false,
    rejectRules: input.rejectRules || {}
}).then(resp => {
    try {
        const parsed = JSON.parse(resp.body);
        if (parsed.error || !parsed.outbounds) {
            process.stderr.write(parsed.error || "未能生成有效outbounds");
            process.exit(1);
        }
    } catch(e) {}
    process.stdout.write(resp.body);
}).catch(err => {
    process.stderr.write(err.message || String(err));
    process.exit(1);
});
"""
        payload = json.dumps({
            "sourceUrl": source_url,
            "targetVersion": sub_info.get("targetVersion", "1.15"),
            "enableTun": sub_info.get("enableTun", True),
            "rejectRules": resolve_sub_rules(sub_info)
        })

        proc = subprocess.run(
            ["node", "--input-type=module", "-e", node_script],
            input=payload,
            cwd=r"z:\SingBoxConvertor",
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=25
        )

        if proc.returncode == 0 and proc.stdout.strip().startswith("{") and '"outbounds"' in proc.stdout:
            # 将转换成功的配置自动写入 Windows 用户临时目录，关闭服务后永久保留方便多次调试
            try:
                with open(temp_filepath, "w", encoding="utf-8") as tf:
                    tf.write(proc.stdout)
                # 同步自动更新 SFW 客户端正在使用的 Profile 映射文件
                sfw_dir = r"C:\ProgramData\sing-box\profiles"
                if os.path.exists(sfw_dir):
                    import glob
                    for pf in glob.glob(os.path.join(sfw_dir, "*.json")):
                        try:
                            with open(pf, "r", encoding="utf-8") as f:
                                d = json.load(f)
                            if len(d.get("outbounds", [])) >= 50 or os.path.basename(pf).startswith("23cac9d9"):
                                with open(pf, "w", encoding="utf-8") as f:
                                    f.write(proc.stdout)
                        except Exception:
                            pass
                sys.stderr.write(f"\n[OK] 转换成功! 配置文件已持久保存在临时目录:\n     -> {temp_filepath}\n\n")
                sys.stderr.flush()
            except Exception as fe:
                sys.stderr.write(f"\n[Warn] 写入临时文件失败: {fe}\n")
            return proc.stdout, temp_filepath, None
        else:
            err_msg = proc.stderr or proc.stdout or "转换失败"
            # 降级保护：如果向机场实时拉取失败，回退提供本地上一份有效配置，避免客户端因收到错误 JSON 而全线断连崩溃！
            if os.path.exists(temp_filepath):
                try:
                    with open(temp_filepath, "r", encoding="utf-8") as tf:
                        cached_json = tf.read()
                    if cached_json.strip().startswith("{") and '"outbounds"' in cached_json:
                        sys.stderr.write(f"\n[降级保护] 实时拉取失败({err_msg.strip()})，已自动回退提供本地上一份有效配置，保障客户端不掉线！\n")
                        sys.stderr.flush()
                        return cached_json, temp_filepath, None
                except Exception:
                    pass
            return None, temp_filepath, err_msg
    except Exception as e:
        return None, temp_filepath, str(e)

class LocalDevHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        req_path = parsed_url.path
        query_params = urllib.parse.parse_qs(parsed_url.query)

        if req_path in ["/", "/index.html"]:
            with open(r"z:\SingBoxConvertor\src\index.js", "r", encoding="utf-8") as f:
                js_content = f.read()
            idx1 = js_content.find("function renderHtml(origin) {")
            idx2 = js_content.find("</html>`;", idx1)
            t = js_content[idx1 + len("function renderHtml(origin) {"):idx2 + 7].strip()
            if t.startswith("return `"):
                t = t[8:]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(t.encode("utf-8"))
        elif req_path == "/api/list":
            items = []
            for k, v in mock_kv.items():
                if k.startswith("sub:"):
                    obj = json.loads(v)
                    items.append({"id": k.replace("sub:", ""), **obj})
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"items": items}, ensure_ascii=False).encode("utf-8"))
        elif req_path == "/api/rule_profiles/list":
            items = []
            found_ids = set()
            for k, v in mock_kv.items():
                if k.startswith("rule_profile:"):
                    try:
                        obj = json.loads(v)
                        pid = k.replace("rule_profile:", "")
                        items.append({"id": pid, **obj})
                        found_ids.add(pid)
                    except Exception:
                        pass
            for rk, rv in DEFAULT_RULE_PROFILES.items():
                pid = rk.replace("rule_profile:", "")
                if pid not in found_ids:
                    try:
                        pobj = json.loads(rv)
                        items.append({"id": pid, **pobj})
                    except Exception:
                        pass
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"items": items}, ensure_ascii=False).encode("utf-8"))
        elif req_path.startswith("/sub/"):
            sub_id = req_path[5:].strip()
            raw_entry = mock_kv.get(f"sub:{sub_id}")
            if not raw_entry:
                self.send_response(404)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(f"未找到订阅 ID: {sub_id}".encode("utf-8"))
                return

            sub_info = json.loads(raw_entry)
            if "version" in query_params:
                sub_info["targetVersion"] = query_params["version"][0]
            if "tun" in query_params:
                sub_info["enableTun"] = query_params["tun"][0].lower() != "false"

            config_json, temp_filepath, err = run_conversion_and_save(sub_id, sub_info)
            if config_json:
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                self.end_headers()
                self.wfile.write(config_json.encode("utf-8"))
            else:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(f"订阅转换失败: {err}".encode("utf-8"))
        elif req_path == "/convert":
            source_url = query_params.get("url", [""])[0]
            if not source_url:
                self.send_response(400)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write("Missing ?url= parameter".encode("utf-8"))
                return
            convert_info = {
                "sourceUrl": source_url,
                "targetVersion": query_params.get("version", ["1.15"])[0],
                "enableTun": query_params.get("tun", ["true"])[0].lower() != "false",
                "ruleProfileId": query_params.get("profile", ["default"])[0],
                "rejectRules": {}
            }
            config_json, _, err = run_conversion_and_save("temp_convert", convert_info)
            if config_json:
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(config_json.encode("utf-8"))
            else:
                self.send_response(500)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(f"转换失败: {err}".encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}
        
        if self.path == "/api/create":
            sub_id = (body.get("id") or "sub_" + os.urandom(3).hex()).strip()
            rule_profile_id = body.get("ruleProfileId") or "default"
            sub_info = {
                "sourceUrl": body.get("sourceUrl"),
                "name": body.get("name") or "未命名订阅",
                "targetVersion": body.get("targetVersion", "1.15"),
                "enableTun": body.get("enableTun", True),
                "ruleProfileId": rule_profile_id,
                "rejectRules": {
                    "domains": parse_input_list(body.get("rejectDomains")),
                    "ips": parse_input_list(body.get("rejectIps")),
                    "packages": parse_input_list(body.get("rejectPackages"))
                },
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
            mock_kv[f"sub:{sub_id}"] = json.dumps(sub_info, ensure_ascii=False)
            save_kv_to_disk()
            # 创建成功时，立即自动触发新文件的生成与持久保存
            _, temp_filepath, gen_err = run_conversion_and_save(sub_id, sub_info)

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({
                "success": True,
                "id": sub_id,
                "filePath": temp_filepath,
                "genError": gen_err
            }, ensure_ascii=False).encode("utf-8"))

        elif self.path == "/api/update":
            sub_id = (body.get("id") or "").strip()
            if f"sub:{sub_id}" in mock_kv:
                prev = json.loads(mock_kv[f"sub:{sub_id}"])
                rule_profile_id = body.get("ruleProfileId") if "ruleProfileId" in body else prev.get("ruleProfileId", "default")
                
                reject_domains = parse_input_list(body.get("rejectDomains")) if "rejectDomains" in body else prev.get("rejectRules", {}).get("domains", [])
                reject_ips = parse_input_list(body.get("rejectIps")) if "rejectIps" in body else prev.get("rejectRules", {}).get("ips", [])
                reject_packages = parse_input_list(body.get("rejectPackages")) if "rejectPackages" in body else prev.get("rejectRules", {}).get("packages", [])

                sub_info = {
                    "sourceUrl": body.get("sourceUrl") or prev.get("sourceUrl"),
                    "name": body.get("name") or prev.get("name"),
                    "targetVersion": body.get("targetVersion") or prev.get("targetVersion", "1.15"),
                    "enableTun": body.get("enableTun") if "enableTun" in body else prev.get("enableTun", True),
                    "ruleProfileId": rule_profile_id,
                    "rejectRules": {
                        "domains": reject_domains,
                        "ips": reject_ips,
                        "packages": reject_packages
                    },
                    "updatedAt": datetime.now(timezone.utc).isoformat()
                }
                mock_kv[f"sub:{sub_id}"] = json.dumps(sub_info, ensure_ascii=False)
                save_kv_to_disk()

                # 修改保存时，立即自动重新生成并覆盖保存本地临时目录中的配置文件
                _, temp_filepath, gen_err = run_conversion_and_save(sub_id, sub_info)

                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "success": True,
                    "id": sub_id,
                    "filePath": temp_filepath,
                    "genError": gen_err
                }, ensure_ascii=False).encode("utf-8"))
            else:
                self.send_response(404)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "未找到指定订阅ID"}, ensure_ascii=False).encode("utf-8"))

        elif self.path == "/api/delete":
            sub_id = (body.get("id") or "").strip()
            if f"sub:{sub_id}" in mock_kv:
                del mock_kv[f"sub:{sub_id}"]
                save_kv_to_disk()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}, ensure_ascii=False).encode("utf-8"))

        elif self.path == "/api/rule_profiles/create":
            pid = (body.get("id") or "rule_" + os.urandom(3).hex()).strip().lower()
            pid = re.sub(r"[^a-z0-9_-]", "", pid)
            if not pid:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "规则配置 ID 格式无效"}, ensure_ascii=False).encode("utf-8"))
                return
            if f"rule_profile:{pid}" in mock_kv:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "该规则配置 ID 已存在，请更换"}, ensure_ascii=False).encode("utf-8"))
                return
            data = {
                "id": pid,
                "name": (body.get("name") or "自定义规则配置").strip(),
                "description": (body.get("description") or "").strip(),
                "domains": parse_input_list(body.get("domains")),
                "ips": parse_input_list(body.get("ips")),
                "packages": parse_input_list(body.get("packages")),
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
            mock_kv[f"rule_profile:{pid}"] = json.dumps(data, ensure_ascii=False)
            save_kv_to_disk()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "id": pid, "data": data}, ensure_ascii=False).encode("utf-8"))

        elif self.path == "/api/rule_profiles/update":
            pid = (body.get("id") or "").strip()
            if not pid:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "缺少规则配置 ID"}, ensure_ascii=False).encode("utf-8"))
                return
            prev = {}
            if f"rule_profile:{pid}" in mock_kv:
                try:
                    prev = json.loads(mock_kv[f"rule_profile:{pid}"])
                except Exception:
                    pass
            elif f"rule_profile:{pid}" in DEFAULT_RULE_PROFILES:
                try:
                    prev = json.loads(DEFAULT_RULE_PROFILES[f"rule_profile:{pid}"])
                except Exception:
                    pass

            data = {
                **prev,
                "id": pid,
                "name": (body.get("name") or prev.get("name") or "自定义规则配置").strip(),
                "description": (body.get("description") if "description" in body else prev.get("description", "")).strip(),
                "domains": parse_input_list(body.get("domains")) if "domains" in body else prev.get("domains", []),
                "ips": parse_input_list(body.get("ips")) if "ips" in body else prev.get("ips", []),
                "packages": parse_input_list(body.get("packages")) if "packages" in body else prev.get("packages", []),
                "updatedAt": datetime.now(timezone.utc).isoformat()
            }
            mock_kv[f"rule_profile:{pid}"] = json.dumps(data, ensure_ascii=False)
            save_kv_to_disk()

            # 联动刷新：重新触发所有绑定该规则配置的订阅重新生成本地配置文件！
            updated_subs = []
            for k, v in list(mock_kv.items()):
                if k.startswith("sub:"):
                    try:
                        s_info = json.loads(v)
                        if s_info.get("ruleProfileId") == pid or (pid == "default" and not s_info.get("ruleProfileId")):
                            s_id = k.replace("sub:", "")
                            run_conversion_and_save(s_id, s_info)
                            updated_subs.append(s_id)
                    except Exception as re_err:
                        print(f"[Warn] 联动重生成订阅失败 {k}: {re_err}")

            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True, "id": pid, "data": data, "refreshedSubs": updated_subs}, ensure_ascii=False).encode("utf-8"))

        elif self.path == "/api/rule_profiles/delete":
            pid = (body.get("id") or "").strip()
            if not pid:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "缺少规则配置 ID"}, ensure_ascii=False).encode("utf-8"))
                return
            if pid in ["none", "default"]:
                self.send_response(400)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "系统基础预置规则配置不可删除"}, ensure_ascii=False).encode("utf-8"))
                return
            if f"rule_profile:{pid}" in mock_kv:
                del mock_kv[f"rule_profile:{pid}"]
                save_kv_to_disk()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"success": True}, ensure_ascii=False).encode("utf-8"))

if __name__ == "__main__":
    print(f"=======================================================")
    print(f" Local Worker Server started at http://127.0.0.1:{PORT}")
    print(f" 临时转换目录: {TEMP_DIR}")
    print(f" 数据存储文件: {KV_STORE_FILE}")
    print(f" 注意: 后台关闭或重启后，临时文件与订阅数据均永久保留！")
    print(f"=======================================================")
    sys.stdout.flush()

    with socketserver.TCPServer(("127.0.0.1", PORT), LocalDevHandler) as httpd:
        httpd.serve_forever()
