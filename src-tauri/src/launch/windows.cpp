#define NOMINMAX
#define UNICODE
#include <initializer_list>
#include <windows.h>
#include <gdiplus.h>
#include <commctrl.h>
#include <memory>

// Presentation-only adapter. Rust owns readiness and launch expiry. A normal
// opaque child covers the WebView until ready; it never hides/suspends the WebView.
// Do not use a layered window here: its full-window composition stalls WebView2
// resource and IPC delivery. Paint is cached and there are no animation timers.
namespace {
struct Overlay {
    HWND window = nullptr;
    bool dark = false;
    bool chinese = false;
    int stage = 0;
    ULONG_PTR graphics = 0;
    HDC cache = nullptr;
    HBITMAP bitmap = nullptr;
    HGDIOBJ previous = nullptr;
    int width = 0, height = 0;
    UINT dpi = 0;
    bool dirty = true;
    bool window_owned = false;

    void clear_cache() {
        if (previous) SelectObject(cache, previous);
        if (bitmap) DeleteObject(bitmap);
        if (cache) DeleteDC(cache);
        cache = nullptr;
        bitmap = nullptr;
        previous = nullptr;
        width = height = 0;
    }
    ~Overlay() {
        clear_cache();
        if (graphics) Gdiplus::GdiplusShutdown(graphics);
    }
};
const wchar_t *key = L"SomsLaunchOverlay";
Gdiplus::Color color(unsigned rgb, BYTE alpha = 255) {
    return Gdiplus::Color(alpha, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
}
void draw(HDC dc, RECT bounds, Overlay &o) {
    using namespace Gdiplus;
    int width = bounds.right, height = bounds.bottom;
    if (width <= 0 || height <= 0) return;
    Graphics g(dc);
    g.Clear(color(o.dark ? 0x11161b : 0xe9e1d5));
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    const float dpi = GetDpiForWindow(o.window) / 96.0f;
    g.ScaleTransform(dpi, dpi);
    const float w = width / dpi, h = height / dpi;
    auto saved = g.Save();
    g.TranslateTransform(w / 2, h / 2 - 24);
    g.ScaleTransform(288.0f / 108 * .82f, 288.0f / 108 * .82f);
    g.TranslateTransform(-54, -54);
    GraphicsPath bubble;
    bubble.AddBezier(54,17,76,17,93,32,93,52);
    bubble.AddBezier(93,52,93,72,76,86,55,86);
    bubble.AddBezier(55,86,48,86,41,85,35,82);
    bubble.AddLine(35,82,25,87); bubble.AddLine(25,87,28,76);
    bubble.AddBezier(28,76,20,68,15,61,15,52);
    bubble.AddBezier(15,52,15,32,32,17,54,17); bubble.CloseFigure();
    SolidBrush paper(color(0xf8f4ec)), ink(color(0x19212a)), red(color(0xf04b3a));
    Pen border(color(0xbbaf9f), 1.5f), mark(color(0x19212a), 8);
    g.FillPath(&paper, &bubble); g.DrawPath(&border, &bubble);
    mark.SetStartCap(LineCapRound); mark.SetEndCap(LineCapRound); mark.SetLineJoin(LineJoinRound);
    Point points[] = {{34,68},{34,40},{54,57},{74,40},{74,68}};
    g.DrawLines(&mark, points, 5);
    for (int x : {34,74}) for (int y : {40,68}) g.FillEllipse(&ink, x-6.5f,y-6.5f,13.0f,13.0f);
    g.FillEllipse(&red,47,50,14,14);
    g.Restore(saved);
    SolidBrush title(color(o.dark ? 0xf0f1f2 : 0x19212a));
    SolidBrush subtitle(color(o.dark ? 0xa9adb1 : 0x5b5349));
    SolidBrush status(color(o.dark ? 0xa9adb1 : 0x5b5349));
    FontFamily family(L"Segoe UI");
    Font bold(&family,28,FontStyleBold,UnitPixel), normal(&family,12,FontStyleRegular,UnitPixel);
    StringFormat centered; centered.SetAlignment(StringAlignmentCenter);
    g.DrawString(L"SOMS",-1,&bold,RectF(24,h/2+66,w-48,34),&centered,&title);
    g.DrawString(o.chinese ? L"开放聊天，简单即时。" : L"Open chat. Simple and instant.",-1,&normal,RectF(24,h/2+110,w-48,28),&centered,&subtitle);
    const wchar_t *en[] = {L"Preparing",L"Restoring session",L"Requesting remote configuration",L"Preparing interface",L"Startup is taking longer. Still preparing…",L"Startup failed. Close the window and reopen the app."};
    const wchar_t *zh[] = {L"准备中",L"恢复会话",L"请求远端配置",L"整理界面",L"启动时间较长，仍在准备…",L"启动失败，请关闭窗口后重新打开应用。"};
    g.DrawString((o.chinese ? zh : en)[o.stage],-1,&normal,RectF(24,h-48,w-48,32),nullptr,&status);
}
void paint(HDC dc, const RECT &bounds, const RECT &damage, Overlay &o) {
    const int width = bounds.right, height = bounds.bottom;
    if (width <= 0 || height <= 0) return;
    const UINT dpi = GetDpiForWindow(o.window);
    if (!o.cache || width != o.width || height != o.height || dpi != o.dpi) {
        o.clear_cache();
        o.cache = CreateCompatibleDC(dc);
        o.bitmap = CreateCompatibleBitmap(dc, width, height);
        if (o.cache && o.bitmap) {
            o.previous = SelectObject(o.cache, o.bitmap);
            if (!o.previous || o.previous == HGDI_ERROR) {
                o.previous = nullptr;
                o.clear_cache();
            }
        } else {
            o.clear_cache();
        }
        o.width = width;
        o.height = height;
        o.dpi = dpi;
        o.dirty = true;
    }
    if (!o.cache) {
        // Allocation failure must still leave an opaque, readable launch page.
        draw(dc, bounds, o);
        return;
    }
    if (o.dirty) {
        draw(o.cache, bounds, o);
        o.dirty = false;
    }
    BitBlt(dc, damage.left, damage.top, damage.right - damage.left,
           damage.bottom - damage.top, o.cache, damage.left, damage.top, SRCCOPY);
}
LRESULT CALLBACK parentProcedure(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR id, DWORD_PTR data);
LRESULT CALLBACK procedure(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    auto o = reinterpret_cast<Overlay *>(GetWindowLongPtrW(hwnd,GWLP_USERDATA));
    if (msg == WM_NCCREATE) {
        o = static_cast<Overlay *>(reinterpret_cast<CREATESTRUCTW *>(lp)->lpCreateParams);
        o->window = hwnd; SetWindowLongPtrW(hwnd,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(o));
        return TRUE;
    }
    if (!o) return DefWindowProcW(hwnd,msg,wp,lp);
    switch (msg) {
    case WM_CREATE: return 0;
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        RECT bounds;
        GetClientRect(hwnd, &bounds);
        paint(dc, bounds, ps.rcPaint, *o);
        EndPaint(hwnd, &ps);
        return 0;
    }
    case WM_PRINTCLIENT: {
        RECT bounds;
        GetClientRect(hwnd, &bounds);
        paint(reinterpret_cast<HDC>(wp), bounds, bounds, *o);
        return 0;
    }
    case WM_SIZE:
    case WM_DPICHANGED_AFTERPARENT:
        o->dirty = true;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
    case WM_NCDESTROY:
        if (GetPropW(GetParent(hwnd),key)==hwnd) {
            RemovePropW(GetParent(hwnd),key);
            RemoveWindowSubclass(GetParent(hwnd),parentProcedure,1);
        }
        SetWindowLongPtrW(hwnd,GWLP_USERDATA,0);
        // Failed creation leaves ownership with install(); successful creation
        // transfers it to the child for normal and parent-driven destruction.
        if (o->window_owned) delete o;
        break;
    }
    return DefWindowProcW(hwnd,msg,wp,lp);
}
LRESULT CALLBACK parentProcedure(HWND hwnd,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR id,DWORD_PTR) {
    if (msg == WM_SIZE) {
        auto child = static_cast<HWND>(GetPropW(hwnd,key));
        if (child) { RECT r; GetClientRect(hwnd,&r); SetWindowPos(child,HWND_TOP,0,0,r.right,r.bottom,SWP_NOACTIVATE); }
    }
    if (msg == WM_NCDESTROY) RemoveWindowSubclass(hwnd,parentProcedure,id);
    return DefSubclassProc(hwnd,msg,wp,lp);
}
}
extern "C" bool soms_windows_launch_install(void *raw, bool dark) {
    HWND parent = static_cast<HWND>(raw);
    WNDCLASSW wc{};
    wc.lpfnWndProc = procedure;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"SomsLaunchPresentation";
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    if (!RegisterClassW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) return false;

    auto owner = std::unique_ptr<Overlay>(new(std::nothrow) Overlay{});
    if (!owner) return false;
    owner->dark = dark;
    owner->chinese = PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_CHINESE;
    Gdiplus::GdiplusStartupInput input;
    if (Gdiplus::GdiplusStartup(&owner->graphics, &input, nullptr) != Gdiplus::Ok) return false;
    RECT bounds;
    GetClientRect(parent, &bounds);
    HWND child = CreateWindowExW(0, wc.lpszClassName, L"SOMS",
        WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS, 0, 0, bounds.right, bounds.bottom,
        parent, nullptr, wc.hInstance, owner.get());
    if (!child) return false;
    owner->window_owned = true;
    owner.release();
    if (!SetPropW(parent, key, child) ||
        !SetWindowSubclass(parent, parentProcedure, 1, 0)) {
        DestroyWindow(child);
        return false;
    }
    return true;
}
extern "C" void soms_windows_launch_raise(void *raw) {
    auto child=static_cast<HWND>(GetPropW(static_cast<HWND>(raw),key));
    if(child) SetWindowPos(child,HWND_TOP,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);
}
extern "C" void soms_windows_launch_present(void *raw, int stage, bool dark, bool finished) {
    HWND parent = static_cast<HWND>(raw);
    auto child = static_cast<HWND>(GetPropW(parent, key));
    if (!child) return;
    auto o = reinterpret_cast<Overlay *>(GetWindowLongPtrW(child, GWLP_USERDATA));
    if (!o) return;
    if (finished) {
        // Rust accepts readiness only from the current renderer after its routed
        // DOM and rendering opportunities settle. No fade/timer delays this handoff.
        DestroyWindow(child);
        RemoveWindowSubclass(parent, parentProcedure, 1);
        RedrawWindow(parent, nullptr, nullptr, RDW_INVALIDATE | RDW_ALLCHILDREN);
        return;
    }
    if (o->stage == stage && o->dark == dark) return;
    o->stage = stage;
    o->dark = dark;
    o->dirty = true;
    InvalidateRect(child, nullptr, FALSE);
}
