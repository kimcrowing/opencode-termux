// ============================================================
//  NXBridge Remote + HTTP Server（Remoting 驻留方案 · 完整 RPC 面）
//  形态：NX Open startup dll（NX 启动自动加载，常驻，无 journal 锁）
//  传输：
//    · .NET Remoting TcpChannel:8124 —— TestClient 等 .NET 客户端
//    · HTTP JSON-RPC :8123 —— opencode/AI 大脑直接 HTTP 遥控（协议见 protocol.md）
//  关键：所有 NXOpen 调用经隐藏 WinForms Control.Invoke 调度到 NX 主线程
//        （新建部件/写操作若非主线程会被 2606 拒绝：错误 4360002）
//  历史：v5 journal 桥（NXBridgeServer_v5.dll）同一 RPC 面迁移于此，去掉 journal 锁
//  已验证（2026-09-13）：NewPart/Block/Tree + Ctrl+Z / Ctrl+Y 用户实测全通
// ============================================================
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Runtime.Remoting;
using System.Runtime.Remoting.Channels;
using System.Runtime.Remoting.Channels.Tcp;
using System.Windows.Forms;
using NXOpen;
using Feature = NXOpen.Features.Feature; // 2606 适配：设计要素类型在 Features 命名空间

// ============================================================================
// 配置
// ============================================================================
public static class NXRemoteConfig
{
    public const int Port = 8124;            // Remoting 端口
    public const int HttpPort = 8123;        // HTTP JSON-RPC 端口
    public const string PrefixHost = "+";    // + = 所有网卡（URL ACL 已配）
    public const string Token = "";          // 留空 = 关闭 HTTP 鉴权（仅内网）
}

public static class Nx
{
    public static string GetNxVersion()
    {
        try
        {
            Session s = Session.GetSession();
            string rel = s.FullReleaseNumber;
            if (!string.IsNullOrEmpty(rel)) return rel;
            return s.ReleaseNumber;
        }
        catch { return "unknown"; }
    }
}

// ============================================================================
// NXBridgeRemote —— Remoting 远程对象（MarshalByRefObject）
// ============================================================================
public class NXBridgeRemote : MarshalByRefObject
{
    static Control _sync; // 绑定 NX 主线程的隐藏控件（窗口句柄在主线程 + 消息泵）

    public static void AttachSync(Control c) { _sync = c; }
    public static void DetachSync()
    {
        if (_sync != null) { try { _sync.Dispose(); } catch { } _sync = null; }
    }

    // 在主线程上同步执行 fn（若已在主线程则直接执行）；阻塞直到主线程完成
    public static T RunMainStatic<T>(Func<T> fn)
    {
        if (_sync == null || !_sync.InvokeRequired)
            return fn();
        T r = default(T);
        Exception err = null;
        _sync.Invoke((MethodInvoker)delegate
        {
            try { r = fn(); }
            catch (Exception ex) { err = ex; }
        });
        if (err != null) throw err;
        return r;
    }

    T RunMain<T>(Func<T> fn) { return RunMainStatic(fn); }

    public override object InitializeLifetimeService()
    {
        return null; // 永不过期
    }

    public string Ping()
    {
        try
        {
            return RunMainStatic(() =>
            {
                Session s = Session.GetSession();
                return "pong nx=" + s.FullReleaseNumber + " pid=" + Process.GetCurrentProcess().Id;
            });
        }
        catch (Exception ex) { return "ERR " + ex.Message; }
    }

    // 通用 RPC：与 HTTP /rpc 共用同一分派（NxHost.Dispatch）
    public string Rpc(string method, string json)
    {
        return RunMainStatic(() =>
        {
            try
            {
                var prms = string.IsNullOrEmpty(json)
                    ? new Dictionary<string, object>()
                    : (Dictionary<string, object>)J.Parse(json);
                object result = NxHost.Dispatch(method, prms);
                return J.Stringify(result);
            }
            catch (Exception ex) { return "{\"error\":\"" + ex.Message.Replace("\"", "'") + "\"}"; }
        });
    }

    // 特征树（调试用简单方法）
    public string Tree()
    {
        try
        {
            return RunMainStatic(() =>
                J.Stringify(NxHost.Dispatch("model.tree", new Dictionary<string, object>())));
        }
        catch (Exception ex) { return "{\"err\":\"" + ex.Message.Replace("\"", "'") + "\"}"; }
    }

    // 建块（调试用简单方法）
    public string Block(double ox, double oy, double oz, double lx, double ly, double lz, string name)
    {
        try
        {
            return RunMainStatic(() => J.Stringify(NxHost.Dispatch("feature.block", new Dictionary<string, object>
            {
                { "origin", new List<object> { ox, oy, oz } },
                { "lengthX", lx }, { "lengthY", ly }, { "lengthZ", lz },
                { "name", name }
            })));
        }
        catch (Exception ex) { return "{\"ok\":false,\"err\":\"" + ex.Message.Replace("\"", "'") + "\"}"; }
    }

    // 新建部件（调试用简单方法）
    public string NewPart(string name)
    {
        try
        {
            return RunMainStatic(() => J.Stringify(NxHost.Dispatch("part.newDisplay", new Dictionary<string, object>
            {
                { "name", name }
            })));
        }
        catch (Exception ex) { return "{\"ok\":false,\"err\":\"" + ex.Message.Replace("\"", "'") + "\"}"; }
    }
}

// ============================================================================
// NxHost —— 业务宿主：所有 RPC 实现（HTTP 与 Remoting 共用）
//   注意：Dispatch 必须在 NX 主线程上执行（调用方用 RunMainStatic 包裹）
// ============================================================================
public static class NxHost
{
    static Session _session;
    static UI _ui;
    static readonly object _gate = new object(); // 串行化（锁在【主线程】内持有）
    static long _requestCount;

    public static void Init()
    {
        _session = Session.GetSession();
        _ui = UI.GetUI();
        // 保证撤销后能 Ctrl+Y 重做（journal/脚本上下文可能关闭 redo 跟踪）
        try { _session.EnableRedo(true); } catch { }
    }

    public static long RequestCount { get { return Interlocked.Read(ref _requestCount); } }

    // 分派（内部持锁，必须在主线程执行）
    public static object Dispatch(string method, Dictionary<string, object> p)
    {
        lock (_gate)
        {
            Interlocked.Increment(ref _requestCount);
            return DispatchCore(method, p);
        }
    }

    static object DispatchCore(string method, Dictionary<string, object> p)
    {
        switch (method)
        {
            case "ping":
            case "server.ping":      return ServerPing();
            case "server.stop":      HttpHost.Stop(); return new Dictionary<string, object> { { "stopped", true } };
            case "session.info":     return SessionInfo();
            case "session.undo":     return UndoSession();
            case "session.redo":     return RedoSession();
            case "part.work":        return PartWork();
            case "part.open":        return PartOpen(GetString(p, "file"));
            case "part.save":        return PartSave();
            case "part.closeAll":    return PartCloseAll();
            case "part.newDisplay":  return PartNewDisplay(GetString(p, "name"));
            case "model.tree":       return ModelTree();
            case "feature.block":    return FeatureBlock(p);
            case "feature.cylinder": return FeatureCylinder(p);
            case "feature.sphere":   return FeatureSphere(p);
            case "feature.suppress":   return FeatureSuppress(GetString(p, "featureId"), true);
            case "feature.unsuppress": return FeatureSuppress(GetString(p, "featureId"), false);
            case "measure.distance": return MeasureDistance(p);
            case "ui.message":       return UiMessage(GetString(p, "text"));
            case "journal.run":      return JournalRun(GetString(p, "code"));
            default:
                throw new Exception("未知方法: " + method + "（见 docs/protocol.md）");
        }
    }

    // ---------------- 业务实现（迁移自 v5，已验证编译+运行） ----------------

    static object ServerPing()
    {
        return new Dictionary<string, object>
        {
            { "pong", true },
            { "time", DateTime.Now.ToString("o") },
            { "nxVersion", Nx.GetNxVersion() }
        };
    }

    static object SessionInfo()
    {
        var res = new Dictionary<string, object>
        {
            { "nxVersion", Nx.GetNxVersion() },
            { "processId", Process.GetCurrentProcess().Id },
            { "server", string.Format("http://{0}:{1}/", NXRemoteConfig.PrefixHost, NXRemoteConfig.HttpPort) },
            { "requests", RequestCount }
        };
        try { res["workPart"] = PartInfo(_session.Parts.Work); }
        catch { res["workPart"] = null; }
        return res;
    }

    static Dictionary<string, object> PartInfo(BasePart part)
    {
        var d = new Dictionary<string, object>();
        try { d["fullPath"] = part.FullPath; } catch { }
        try { d["name"] = part.Name; } catch { }
        try { d["units"] = part.PartUnits.ToString(); } catch { }
        try { d["modified"] = part.IsModified; } catch { }
        return d;
    }

    static object PartWork()
    {
        try { return PartInfo(_session.Parts.Work); }
        catch { return null; }
    }

    static object PartOpen(string file)
    {
        if (string.IsNullOrEmpty(file)) throw new Exception("缺少参数 file（部件完整路径）");
        try
        {
            Part work = _session.Parts.Work;
            if (string.Equals(work.FullPath, file, StringComparison.OrdinalIgnoreCase))
                return new Dictionary<string, object> { { "alreadyOpen", true }, { "part", PartInfo(work) } };
        }
        catch { }

        PartLoadStatus status;
        BasePart part = _session.Parts.OpenActiveDisplay(file, NXOpen.DisplayPartOption.ReplaceExisting, out status);
        return new Dictionary<string, object>
        {
            { "alreadyOpen", false },
            { "part", PartInfo(part) },
            { "loadStatus", status == null ? null : status.NumberUnloadedParts.ToString() }
        };
    }

    static object PartSave()
    {
        bool anyPartsModified;
        NXOpen.PartSaveStatus saveStatus;
        _session.Parts.SaveAll(out anyPartsModified, out saveStatus);
        return new Dictionary<string, object> { { "saved", true } };
    }

    static object PartCloseAll()
    {
        _session.Parts.CloseAll(NXOpen.BasePart.CloseModified.DontCloseModified,
                                _session.Parts.NewPartCloseResponses());
        return new Dictionary<string, object> { { "closed", true } };
    }

    static object PartNewDisplay(string name)
    {
        string safe = string.IsNullOrEmpty(name) ? "RemoteModel" : name;
        Part np = _session.Parts.NewDisplay(safe, NXOpen.Part.Units.Millimeters);
        return PartInfo(np);
    }

    static object ModelTree()
    {
        Part work = RequireWork();
        var res = new Dictionary<string, object> { { "part", PartInfo(work) } };

        var bodies = new List<object>();
        try
        {
            foreach (Body b in work.Bodies.ToArray())
            {
                var d = new Dictionary<string, object>();
                try { d["name"] = b.Name; } catch { }
                try { d["type"] = b.IsSolidBody ? "solid" : (b.IsSheetBody ? "sheet" : "other"); } catch { }
                try { d["faces"] = b.GetFaces().Length; } catch { }
                try { d["edges"] = b.GetEdges().Length; } catch { }
                bodies.Add(d);
            }
        }
        catch { }
        res["bodies"] = bodies;

        var features = new List<object>();
        try
        {
            foreach (Feature f in work.Features.ToArray())
            {
                var d = new Dictionary<string, object>();
                try { d["name"] = f.GetFeatureName(); } catch { }
                try { d["type"] = f.FeatureType; } catch { }
                try { d["journalId"] = f.JournalIdentifier; } catch { }
                features.Add(d);
            }
        }
        catch { }
        res["features"] = features;
        return res;
    }

    static object FeatureBlock(Dictionary<string, object> p)
    {
        Part work = RequireWork();
        bool metric = IsMetric(work);
        double[] o = GetPoint(p, "origin");
        double lx = ToPart(GetDouble(p, "lengthX", 10), metric);
        double ly = ToPart(GetDouble(p, "lengthY", 10), metric);
        double lz = ToPart(GetDouble(p, "lengthZ", 10), metric);

        return WithUndo("feature.block", delegate
        {
            var b = work.Features.CreateBlockFeatureBuilder(null);
            b.SetOriginAndLengths(
                new Point3d(ToPart(o[0], metric), ToPart(o[1], metric), ToPart(o[2], metric)),
                Fmt(lx), Fmt(ly), Fmt(lz));
            NXObject nxo = b.Commit();
            b.Destroy();
            TryName(nxo, GetString(p, "name"));
            return FeatureOf(nxo);
        });
    }

    static object FeatureCylinder(Dictionary<string, object> p)
    {
        Part work = RequireWork();
        bool metric = IsMetric(work);
        double[] o = GetPoint(p, "origin");
        double[] d = GetVector(p, "direction", new double[] { 0, 0, 1 });

        return WithUndo("feature.cylinder", delegate
        {
            var b = work.Features.CreateCylinderBuilder(null);
            b.Origin = new Point3d(ToPart(o[0], metric), ToPart(o[1], metric), ToPart(o[2], metric));
            b.Direction = new Vector3d(d[0], d[1], d[2]);
            b.Diameter.SetFormula(Fmt(ToPart(GetDouble(p, "diameter", 10), metric)));
            b.Height.SetFormula(Fmt(ToPart(GetDouble(p, "height", 10), metric)));
            NXObject nxo = b.Commit();
            b.Destroy();
            TryName(nxo, GetString(p, "name"));
            return FeatureOf(nxo);
        });
    }

    static object FeatureSphere(Dictionary<string, object> p)
    {
        Part work = RequireWork();
        bool metric = IsMetric(work);
        double[] o = GetPoint(p, "origin");

        return WithUndo("feature.sphere", delegate
        {
            var b = work.Features.CreateSphereBuilder(null);
            b.CenterPoint = work.Points.CreatePoint(
                new Point3d(ToPart(o[0], metric), ToPart(o[1], metric), ToPart(o[2], metric)));
            b.Diameter.SetFormula(Fmt(ToPart(GetDouble(p, "diameter", 10), metric)));
            NXObject nxo = b.Commit();
            b.Destroy();
            TryName(nxo, GetString(p, "name"));
            return FeatureOf(nxo);
        });
    }

    static object FeatureSuppress(string journalId, bool suppress)
    {
        Part work = RequireWork();
        if (string.IsNullOrEmpty(journalId)) throw new Exception("缺少参数 featureId（用 model.tree 查询 journalId）");

        Feature target = null;
        foreach (Feature f in work.Features.ToArray())
        {
            if (f.JournalIdentifier == journalId) { target = f; break; }
        }
        if (target == null) throw new Exception("未找到特征 " + journalId);

        return WithUndo(suppress ? "feature.suppress" : "feature.unsuppress", delegate
        {
            if (suppress) target.Suppress();
            else target.Unsuppress();
            return new Dictionary<string, object>
            {
                { "journalId", journalId },
                { "name", SafeName(target) },
                { "suppressed", suppress }
            };
        });
    }

    static object MeasureDistance(Dictionary<string, object> p)
    {
        double[] p1 = GetPoint(p, "p1");
        double[] p2 = GetPoint(p, "p2");
        double dx = p2[0] - p1[0], dy = p2[1] - p1[1], dz = p2[2] - p1[2];
        return new Dictionary<string, object>
        {
            { "distance", Math.Sqrt(dx * dx + dy * dy + dz * dz) },
            { "units", "mm" },
            { "note", "坐标间欧氏距离；面/边测量请用 journal.run 生成代码" }
        };
    }

    static object UiMessage(string text)
    {
        if (string.IsNullOrEmpty(text)) throw new Exception("缺少参数 text");
        _ui.NXMessageBox.Show("NX Copilot", NXMessageBox.DialogType.Information, text);
        return new Dictionary<string, object> { { "shown", true } };
    }

    static object JournalRun(string code)
    {
        if (string.IsNullOrEmpty(code)) throw new Exception("缺少参数 code（NXOpen C# 代码）");
        return JournalRunner.Run(_session, _ui, code);
    }

    // 撤销最近 1 个可见 undo mark（= 最近一次 AI 建模操作）
    static object UndoSession()
    {
        bool recycled, unavailable;
        _session.UndoLastNVisibleMarks(1, out recycled, out unavailable);
        if (unavailable)
            return new Dictionary<string, object> { { "undone", false }, { "note", "没有可撤销的可见标记" } };
        return new Dictionary<string, object> { { "undone", true } };
    }

    static object RedoSession()
    {
        try
        {
            _session.Redo();
            return new Dictionary<string, object> { { "redone", true } };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object> { { "redone", false }, { "note", "无法重做：" + ex.Message } };
        }
    }

    // ---------------- 工具方法 ----------------

    static Part RequireWork()
    {
        try { return _session.Parts.Work; }
        catch { throw new Exception("NX 中没有打开的部件：请先在 NX 中打开或新建部件（part.newDisplay / part.open）"); }
    }

    static bool IsMetric(BasePart part)
    {
        try { return part.PartUnits == BasePart.Units.Millimeters; }
        catch { return true; }
    }

    static double ToPart(double mm, bool metric) { return metric ? mm : mm / 25.4; }

    // 正确模式（对照录制 journal）：Visible 标记成功后必须保留，用户才能在 Ctrl+Z 撤销列表看到
    static object WithUndo(string opName, Func<object> body)
    {
        // 官方文档：NX Open program 上下文（含 startup 常驻 dll）默认关闭 redo 跟踪，
        // 从禁用切到启用【必须在设置 undo mark 之前】调用 —— 每次操作前重开，避免 redo 数据丢失
        try { _session.EnableRedo(true); } catch { }
        Session.UndoMarkId mark = _session.SetUndoMark(Session.MarkVisibility.Visible, "NX Copilot: " + opName);
        try
        {
            object result = body();
            _session.UpdateManager.DoUpdate(mark);
            return result; // 不删除标记：保留可撤销点
        }
        catch
        {
            try { _session.UndoToMark(mark, "NX Copilot: " + opName); } catch { }
            try { _session.DeleteUndoMark(mark, null); } catch { }
            throw;
        }
    }

    static Dictionary<string, object> FeatureOf(NXObject nxo)
    {
        var d = new Dictionary<string, object>();
        try { d["journalId"] = nxo.JournalIdentifier; } catch { }
        d["name"] = SafeName(nxo);
        return d;
    }

    static string SafeName(NXObject nxo)
    {
        try { return nxo.Name; } catch { return ""; }
    }

    static void TryName(NXObject nxo, string name)
    {
        if (string.IsNullOrEmpty(name)) return;
        try { nxo.SetName(name); } catch { }
    }

    static string Fmt(double v)
    {
        return v.ToString("R", CultureInfo.InvariantCulture);
    }

    static string GetString(Dictionary<string, object> p, string key)
    {
        object v;
        return p.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : null;
    }

    static double GetDouble(Dictionary<string, object> p, string key, double def)
    {
        object v;
        if (p.TryGetValue(key, out v) && v != null)
        {
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); }
            catch { }
        }
        return def;
    }

    static double[] GetPoint(Dictionary<string, object> p, string key)
    {
        return GetVector(p, key, new double[] { 0, 0, 0 });
    }

    static double[] GetVector(Dictionary<string, object> p, string key, double[] def)
    {
        object v;
        if (p.TryGetValue(key, out v) && v is List<object>)
        {
            var list = (List<object>)v;
            if (list.Count >= 3)
            {
                try
                {
                    return new double[]
                    {
                        Convert.ToDouble(list[0], CultureInfo.InvariantCulture),
                        Convert.ToDouble(list[1], CultureInfo.InvariantCulture),
                        Convert.ToDouble(list[2], CultureInfo.InvariantCulture)
                    };
                }
                catch { }
            }
        }
        return def;
    }
}

// ============================================================================
// HttpHost —— NX 进程内 HTTP JSON-RPC 服务（:8123）
// ============================================================================
public static class HttpHost
{
    static HttpListener _listener;
    static volatile bool _running;

    public static bool IsRunning { get { return _running; } }

    public static void Start()
    {
        string prefix = string.Format("http://{0}:{1}/", NXRemoteConfig.PrefixHost, NXRemoteConfig.HttpPort);
        _listener = new HttpListener();
        _listener.Prefixes.Add(prefix);
        _listener.Start();
        _running = true;
        Thread w = new Thread(AcceptLoop);
        w.IsBackground = true;
        w.Name = "NXHost-http";
        w.Start();
    }

    public static void Stop()
    {
        _running = false;
        try { _listener.Stop(); } catch { }
        try { _listener.Close(); } catch { }
    }

    static void AcceptLoop()
    {
        while (_running)
        {
            HttpListenerContext context;
            try { context = _listener.GetContext(); }
            catch { break; } // 监听器已停止
            ThreadPool.QueueUserWorkItem(_ => Handle(context));
        }
    }

    static void Handle(HttpListenerContext context)
    {
        try
        {
            if (context.Request.HttpMethod == "GET" && context.Request.Url.AbsolutePath == "/ping")
            {
                byte[] body = Encoding.UTF8.GetBytes("pong");
                context.Response.StatusCode = 200;
                context.Response.ContentType = "text/plain; charset=utf-8";
                context.Response.OutputStream.Write(body, 0, body.Length);
                context.Response.OutputStream.Close();
                return;
            }

            if (context.Request.HttpMethod != "POST" || context.Request.Url.AbsolutePath != "/rpc")
            {
                RespondError(context, -32601, "method not found", "仅支持 POST /rpc 与 GET /ping");
                return;
            }

            // 鉴权
            string auth = context.Request.Headers["Authorization"];
            bool authorized = NXRemoteConfig.Token == "" ||
                              (auth != null && auth == "Bearer " + NXRemoteConfig.Token);
            if (!authorized)
            {
                RespondError(context, -32001, "unauthorized", "令牌无效或缺失（Authorization: Bearer <token>）");
                return;
            }

            // 读取请求体（上限 4MB）
            string bodyText;
            using (var reader = new StreamReader(context.Request.InputStream, Encoding.UTF8))
            {
                char[] buf = new char[4 * 1024 * 1024 + 1];
                int read = reader.Read(buf, 0, buf.Length);
                if (read > 4 * 1024 * 1024)
                {
                    RespondError(context, -32600, "invalid request", "请求体过大（> 4MB）");
                    return;
                }
                bodyText = new string(buf, 0, read);
            }

            object request;
            try { request = J.Parse(bodyText); }
            catch { RespondError(context, -32700, "parse error", "JSON 解析失败"); return; }

            var req = request as Dictionary<string, object>;
            if (req == null || !req.ContainsKey("method"))
            {
                RespondError(context, -32600, "invalid request", "缺少 method");
                return;
            }

            string method = Convert.ToString(req["method"]);
            object paramsObj = null;
            req.TryGetValue("params", out paramsObj);
            var prms = paramsObj as Dictionary<string, object> ?? new Dictionary<string, object>();

            long id = -1;
            if (req.ContainsKey("id")) { try { id = Convert.ToInt64(req["id"]); } catch { } }

            // 主线程调度 + 分派（NXOpen 调用强制主线程）
            object result;
            try
            {
                result = NXBridgeRemote.RunMainStatic(() => NxHost.Dispatch(method, prms));
            }
            catch (Exception ex)
            {
                RespondJson(context, new Dictionary<string, object>
                {
                    { "jsonrpc", "2.0" },
                    { "id", id },
                    { "error", new Dictionary<string, object> { { "code", -32000 }, { "message", ex.Message } } }
                });
                return;
            }

            RespondJson(context, new Dictionary<string, object>
            {
                { "jsonrpc", "2.0" },
                { "id", id },
                { "result", result }
            });
        }
        catch (Exception ex)
        {
            try { RespondError(context, -32000, "internal error", ex.Message); }
            catch { }
        }
    }

    static void RespondError(HttpListenerContext context, int code, string message, string detail)
    {
        RespondJson(context, new Dictionary<string, object>
        {
            { "jsonrpc", "2.0" },
            { "id", null },
            { "error", new Dictionary<string, object> { { "code", code }, { "message", message }, { "detail", detail } } }
        });
    }

    static void RespondJson(HttpListenerContext context, object payload)
    {
        byte[] body = Encoding.UTF8.GetBytes(J.Stringify(payload));
        context.Response.StatusCode = 200;
        context.Response.ContentType = "application/json; charset=utf-8";
        context.Response.ContentLength64 = body.Length;
        context.Response.OutputStream.Write(body, 0, body.Length);
        context.Response.OutputStream.Close();
    }
}

// ============================================================================
// JournalRunner —— journal.run：把模型生成的 C# 代码用 csc.exe 编译后在 NX 进程内执行
// ============================================================================
public static class JournalRunner
{
    // v5 用 string.Format 嵌入用户代码 -> 宿主类体花括号未转义使 FormatException（journal.run 从 v5 起从未跑通）
    // 改用前后拼接，避开花括号解析问题
    private const string HostHeader =
        "using System;\n" +
        "using System.Collections.Generic;\n" +
        "using NXOpen;\n" +
        "\n" +
        "public static class NxCopilotJournal\n" +
        "{\n" +
        "    public static Session theSession;\n" +
        "    public static UI theUI;\n" +
        "    public static string RESULT;\n" +
        "\n" +
        "    public static void Run()\n" +
        "    {\n";

    private const string HostFooter =
        "\n    }\n" +
        "}\n";

    public static object Run(Session session, UI ui, string code)
    {
        string src = HostHeader + code + HostFooter;

        string csc = FindCsc();
        if (csc == null)
        {
            return new Dictionary<string, object>
            {
                { "ok", false },
                { "error", "未找到 csc.exe（.NET Framework 4.x 编译器）。请把生成的代码另存为 .cs 文件，用 File→Execute→NX Open 手动运行。" }
            };
        }

        string tmpDir = Path.Combine(Path.GetTempPath(), "nxhost-" + Process.GetCurrentProcess().Id);
        Directory.CreateDirectory(tmpDir);
        string srcFile = Path.Combine(tmpDir, "journal_" + DateTime.Now.Ticks + ".cs");
        string dllFile = Path.ChangeExtension(srcFile, ".dll");
        File.WriteAllText(srcFile, src, Encoding.UTF8);

        string refs = BuildReferences();
        string args = string.Format(
            "/nologo /target:library /out:\"{0}\" {1} \"{2}\"",
            dllFile, refs, srcFile);

        ProcessStartInfo psi = new ProcessStartInfo(csc, args);
        psi.UseShellExecute = false;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.CreateNoWindow = true;

        string stdout, stderr;
        using (Process proc = Process.Start(psi))
        {
            stdout = proc.StandardOutput.ReadToEnd();
            stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            if (proc.ExitCode != 0)
            {
                return new Dictionary<string, object>
                {
                    { "ok", false },
                    { "compileErrors", SplitErrors(stderr) },
                    { "hint", "把编译错误返回给 AI 让它修正代码后重试" }
                };
            }
        }

        try
        {
            var asm = System.Reflection.Assembly.LoadFrom(dllFile);
            Type t = asm.GetType("NxCopilotJournal");
            t.GetField("theSession").SetValue(null, session);
            t.GetField("theUI").SetValue(null, ui);
            t.GetMethod("Run").Invoke(null, null);
            string result = (string)t.GetField("RESULT").GetValue(null);
            return new Dictionary<string, object> { { "ok", true }, { "result", result } };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object>
            {
                { "ok", false },
                { "runtimeError", ex.InnerException != null ? ex.InnerException.Message : ex.Message }
            };
        }
    }

    private static string FindCsc()
    {
        string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string[] candidates =
        {
            Path.Combine(win, @"Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
            Path.Combine(win, @"Microsoft.NET\Framework\v4.0.30319\csc.exe")
        };
        foreach (string c in candidates)
        {
            if (File.Exists(c)) return c;
        }
        return null;
    }

    private static string BuildReferences()
    {
        var list = new List<string>();
        string nxDir = Path.GetDirectoryName(typeof(Session).Assembly.Location);
        if (nxDir != null)
        {
            foreach (string dll in Directory.GetFiles(nxDir, "NXOpen*.dll"))
            {
                list.Add("/r:\"" + dll + "\"");
            }
        }
        list.Add("/r:System.dll");
        list.Add("/r:System.Core.dll");
        return string.Join(" ", list.ToArray());
    }

    private static List<string> SplitErrors(string stderr)
    {
        var errors = new List<string>();
        foreach (string line in stderr.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.IndexOf("error CS", StringComparison.Ordinal) >= 0) errors.Add(line.Trim());
        }
        return errors;
    }
}

// ============================================================================
// 极简 JSON 解析/序列化（零外部依赖）
// ============================================================================
public static class J
{
    public static object Parse(string text)
    {
        int pos = 0;
        object v = ParseValue(text, ref pos);
        SkipWs(text, ref pos);
        if (pos != text.Length) throw new Exception("JSON 尾随内容");
        return v;
    }

    private static object ParseValue(string s, ref int pos)
    {
        SkipWs(s, ref pos);
        if (pos >= s.Length) throw new Exception("JSON 意外结束");
        char c = s[pos];
        switch (c)
        {
            case '{':
                {
                    var d = new Dictionary<string, object>();
                    pos++;
                    SkipWs(s, ref pos);
                    if (pos < s.Length && s[pos] == '}') { pos++; return d; }
                    while (true)
                    {
                        SkipWs(s, ref pos);
                        string key = ParseString(s, ref pos);
                        SkipWs(s, ref pos);
                        if (pos >= s.Length || s[pos] != ':') throw new Exception("JSON 缺少 ':'");
                        pos++;
                        object v = ParseValue(s, ref pos);
                        d[key] = v;
                        SkipWs(s, ref pos);
                        if (pos >= s.Length) throw new Exception("JSON 缺少 '}'");
                        if (s[pos] == ',') { pos++; continue; }
                        if (s[pos] == '}') { pos++; return d; }
                        throw new Exception("JSON 对象分隔符错误");
                    }
                }
            case '[':
                {
                    var list = new List<object>();
                    pos++;
                    SkipWs(s, ref pos);
                    if (pos < s.Length && s[pos] == ']') { pos++; return list; }
                    while (true)
                    {
                        list.Add(ParseValue(s, ref pos));
                        SkipWs(s, ref pos);
                        if (pos >= s.Length) throw new Exception("JSON 缺少 ']'");
                        if (s[pos] == ',') { pos++; continue; }
                        if (s[pos] == ']') { pos++; return list; }
                        throw new Exception("JSON 数组分隔符错误");
                    }
                }
            case '"': return ParseString(s, ref pos);
            case 't':
                Expect(s, ref pos, "true"); return true;
            case 'f':
                Expect(s, ref pos, "false"); return false;
            case 'n':
                Expect(s, ref pos, "null"); return null;
            default:
                if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber(s, ref pos);
                throw new Exception("JSON 非法字符: " + c);
        }
    }

    private static void Expect(string s, ref int pos, string word)
    {
        if (pos + word.Length > s.Length || s.Substring(pos, word.Length) != word)
            throw new Exception("JSON 关键字错误: " + word);
        pos += word.Length;
    }

    private static string ParseString(string s, ref int pos)
    {
        if (pos >= s.Length || s[pos] != '"') throw new Exception("JSON 字符串缺少引号");
        pos++;
        var sb = new StringBuilder();
        while (pos < s.Length)
        {
            char c = s[pos];
            if (c == '"') { pos++; return sb.ToString(); }
            if (c == '\\')
            {
                pos++;
                if (pos >= s.Length) break;
                char e = s[pos];
                switch (e)
                {
                    case '"': sb.Append('"'); break;
                    case '\\': sb.Append('\\'); break;
                    case '/': sb.Append('/'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'u':
                        if (pos + 4 < s.Length)
                        {
                            string hex = s.Substring(pos + 1, 4);
                            sb.Append((char)int.Parse(hex, NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                            pos += 4;
                        }
                        break;
                    default: sb.Append(e); break;
                }
                pos++;
            }
            else
            {
                sb.Append(c);
                pos++;
            }
        }
        throw new Exception("JSON 字符串未闭合");
    }

    private static object ParseNumber(string s, ref int pos)
    {
        int start = pos;
        while (pos < s.Length && (char.IsDigit(s[pos]) || s[pos] == '-' || s[pos] == '+' || s[pos] == '.' || s[pos] == 'e' || s[pos] == 'E'))
            pos++;
        string token = s.Substring(start, pos - start);
        if (token.IndexOf('.') < 0 && token.IndexOf('e') < 0 && token.IndexOf('E') < 0)
        {
            long l;
            if (long.TryParse(token, NumberStyles.Integer, CultureInfo.InvariantCulture, out l)) return l;
        }
        double d;
        if (double.TryParse(token, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
        throw new Exception("JSON 数字错误: " + token);
    }

    private static void SkipWs(string s, ref int pos)
    {
        while (pos < s.Length && (s[pos] == ' ' || s[pos] == '\t' || s[pos] == '\r' || s[pos] == '\n')) pos++;
    }

    public static string Stringify(object value)
    {
        var sb = new StringBuilder();
        Write(value, sb);
        return sb.ToString();
    }

    private static void Write(object value, StringBuilder sb)
    {
        if (value == null) { sb.Append("null"); return; }
        if (value is string) { WriteString((string)value, sb); return; }
        if (value is bool) { sb.Append((bool)value ? "true" : "false"); return; }
        if (value is int || value is long || value is short || value is byte)
        {
            sb.Append(Convert.ToInt64(value).ToString(CultureInfo.InvariantCulture));
            return;
        }
        if (value is double || value is float || value is decimal)
        {
            sb.Append(Convert.ToDouble(value, CultureInfo.InvariantCulture).ToString("R", CultureInfo.InvariantCulture));
            return;
        }
        if (value is IDictionary<string, object>)
        {
            var d = (IDictionary<string, object>)value;
            sb.Append('{');
            bool first = true;
            foreach (var kv in d)
            {
                if (!first) sb.Append(',');
                first = false;
                WriteString(kv.Key, sb);
                sb.Append(':');
                Write(kv.Value, sb);
            }
            sb.Append('}');
            return;
        }
        if (value is System.Collections.IEnumerable)
        {
            sb.Append('[');
            bool first = true;
            foreach (object item in (System.Collections.IEnumerable)value)
            {
                if (!first) sb.Append(',');
                first = false;
                Write(item, sb);
            }
            sb.Append(']');
            return;
        }
        WriteString(value.ToString(), sb);
    }

    private static void WriteString(string s, StringBuilder sb)
    {
        sb.Append('"');
        foreach (char c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                    else sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }
}

// ============================================================================
// NXRemoteServer —— NX startup dll 入口（NX 启动自动加载）
// ============================================================================
public static class NXRemoteServer
{
    static readonly string LogPath = @"C:\Users\Kim\remotesrv_log.txt";
    static TcpChannel _channel;

    static void Log(string msg)
    {
        try { File.AppendAllText(LogPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " " + msg + Environment.NewLine); }
        catch { }
    }

    // 多签名重载：NX 版本间查找的签名不同（C# 模板常见无参 Startup()）
    public static int Startup()
    {
        return StartupCore(null);
    }

    public static int Startup(string[] args)
    {
        return StartupCore(args);
    }

    static int StartupCore(string[] args)
    {
        Log("Startup called (args=" + (args == null ? 0 : args.Length) + ")");
        try
        {
            Session s = Session.GetSession();
            Log("Session nx=" + s.FullReleaseNumber);

            // 1) 建立绑定主线程的隐藏控件（NX 启动加载 startup dll 在主线程上执行）
            var sync = new Control();
            IntPtr h = sync.Handle; // 强制创建原生窗口句柄（绑定当前=主线程）
            NXBridgeRemote.AttachSync(sync);

            // 2) 业务宿主初始化（Session/UI/EnableRedo）
            NxHost.Init();

            // 3) Remoting 通道
            _channel = new TcpChannel(NXRemoteConfig.Port);
            ChannelServices.RegisterChannel(_channel, false);
            RemotingServices.Marshal(new NXBridgeRemote(), "NXBridge");
            Log("TcpChannel registered on " + NXRemoteConfig.Port + ", NXBridge marshaled OK");

            // 4) HTTP JSON-RPC（进程内，AI 大脑用）
            try
            {
                HttpHost.Start();
                Log("HttpListener on " + NXRemoteConfig.HttpPort + " started OK");
            }
            catch (Exception ex) { Log("HttpHost ERR: " + ex.Message); }

            return 0;
        }
        catch (Exception ex)
        {
            Log("Startup ERR: " + ex.ToString());
            return 1;
        }
    }

    public static int GetUnloadOption(string arg)
    {
        return 1; // Session.LibraryUnloadOption.Explicitly
    }

    public static void UnloadLibrary(string arg)
    {
        Log("UnloadLibrary called");
        HttpHost.Stop();
        NXBridgeRemote.DetachSync();
        try { if (_channel != null) ChannelServices.UnregisterChannel(_channel); }
        catch (Exception ex) { Log("Unregister ERR: " + ex.Message); }
    }

    // File->Execute 手动加载时的 journal 模式（仅调试备用）
    public static void Main(string[] args)
    {
        Log("Main (execute mode) called");
        Startup(args);
        Log("Main waiting (poll remote_stop.flag)...");
        while (!File.Exists(@"C:\Users\Kim\remote_stop.flag"))
        {
            Thread.Sleep(1000);
        }
        UnloadLibrary(null);
        Log("Main exit");
    }
}