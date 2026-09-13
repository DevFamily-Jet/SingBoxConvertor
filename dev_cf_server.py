import http.server
import socketserver
import json
import os
import sys
import subprocess
import tempfile
import signal

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

def load_kv_from_disk():
    global mock_kv
    # 如果旧位置在项目目录内存在文件，自动安全迁移至系统用户数据目录，避免误提交云端
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
                    return
        except Exception:
            pass
    # 初始默认数据
    mock_kv = {
        "sub:99": json.dumps({
            "sourceUrl": "https://js.ebox.de5.net/jsh/sub?target=clash",
            "name": "主力机场 (99)",
            "targetVersion": "1.14",
            "enableTun": True,
            "rejectRules": {
                "domains": [],
                "ips": [],
                "packages": []
            },
            "updatedAt": "2026-09-13T03:13:00.000Z"
        }, ensure_ascii=False),
        "sub:sample-sub": json.dumps({
            "sourceUrl": "https://example.com/api/v1/client/subscribe?token=demo_token",
            "name": "示例主力机场 (含拦截规则)",
            "targetVersion": "1.14",
            "enableTun": True,
            "rejectRules": {
                "domains": ["tiktok.com", "douyin.com", "adservice.google.com"],
                "ips": ["123.56.78.90/32"],
                "packages": ["com.ss.android.ugc.aweme", "pinduoduo.exe"]
            },
            "updatedAt": "2026-09-12T06:30:00.000Z"
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
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    URL,
    Response: class { constructor(b, i) { this.body = b; this.init = i; } },
    fetch: globalThis.fetch
};

vm.createContext(sandbox);
vm.runInContext(content.replace('export default {', 'const handler = {'), sandbox);

sandbox.convertFromUrl(input.sourceUrl, {
    targetVersion: input.targetVersion || "1.14",
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
            "targetVersion": sub_info.get("targetVersion", "1.14"),
            "enableTun": sub_info.get("enableTun", True),
            "rejectRules": sub_info.get("rejectRules", {})
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
                sfw_profile = r"C:\ProgramData\sing-box\profiles\03da73d5-a3ed-495b-bdd8-fb23c45bff93.json"
                if os.path.exists(sfw_profile):
                    try:
                        with open(sfw_profile, "w", encoding="utf-8") as pf:
                            pf.write(proc.stdout)
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
        if self.path in ["/", "/index.html"]:
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
        elif self.path == "/api/list":
            items = []
            for k, v in mock_kv.items():
                if k.startswith("sub:"):
                    obj = json.loads(v)
                    items.append({"id": k.replace("sub:", ""), **obj})
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            self.wfile.write(json.dumps({"items": items}, ensure_ascii=False).encode("utf-8"))
        elif self.path.startswith("/sub/"):
            sub_id = self.path[5:]
            raw_entry = mock_kv.get(f"sub:{sub_id}")
            if not raw_entry:
                self.send_response(404)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                self.wfile.write(f"未找到订阅 ID: {sub_id}".encode("utf-8"))
                return

            sub_info = json.loads(raw_entry)
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
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length).decode("utf-8")) if length > 0 else {}
        
        if self.path == "/api/create":
            sub_id = (body.get("id") or "sub_" + os.urandom(3).hex()).strip()
            sub_info = {
                "sourceUrl": body.get("sourceUrl"),
                "name": body.get("name") or "未命名订阅",
                "targetVersion": body.get("targetVersion", "1.14"),
                "enableTun": body.get("enableTun", True),
                "rejectRules": {
                    "domains": [s.strip() for s in body.get("rejectDomains", "").replace("\n", ",").split(",") if s.strip()],
                    "ips": [s.strip() for s in body.get("rejectIps", "").replace("\n", ",").split(",") if s.strip()],
                    "packages": [s.strip() for s in body.get("rejectPackages", "").replace("\n", ",").split(",") if s.strip()]
                },
                "updatedAt": "2026-09-13T03:30:00.000Z"
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
                sub_info = {
                    "sourceUrl": body.get("sourceUrl") or prev.get("sourceUrl"),
                    "name": body.get("name") or prev.get("name"),
                    "targetVersion": body.get("targetVersion") or prev.get("targetVersion", "1.14"),
                    "enableTun": prev.get("enableTun", True),
                    "rejectRules": {
                        "domains": [s.strip() for s in body.get("rejectDomains", "").replace("\n", ",").split(",") if s.strip()],
                        "ips": [s.strip() for s in body.get("rejectIps", "").replace("\n", ",").split(",") if s.strip()],
                        "packages": [s.strip() for s in body.get("rejectPackages", "").replace("\n", ",").split(",") if s.strip()]
                    },
                    "updatedAt": "2026-09-13T03:30:00.000Z"
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

print(f"=======================================================")
print(f" Local Worker Server started at http://127.0.0.1:{PORT}")
print(f" 临时转换目录: {TEMP_DIR}")
print(f" 数据存储文件: {KV_STORE_FILE}")
print(f" 注意: 后台关闭或重启后，临时文件与订阅数据均永久保留！")
print(f"=======================================================")
sys.stdout.flush()

with socketserver.TCPServer(("127.0.0.1", PORT), LocalDevHandler) as httpd:
    httpd.serve_forever()
