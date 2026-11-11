#define NOMINMAX
#define UNICODE
#include <cstdio>
#include <initializer_list>
#include <windows.h>
#include <gdiplus.h>
#include <commctrl.h>
#include <cmath>
#include <new>

// Presentation-only adapter. Rust owns readiness and launch expiry. All calls and
// timers execute on the window thread; destruction cancels the animation timer.
namespace {
struct Overlay {
    HWND window;
    bool dark;
    bool reduced;
    bool chinese;
    int stage = 0;
    ULONGLONG started = GetTickCount64();
    ULONGLONG fading = 0;
    double reveal, delay, brand, fade = 180;
    ULONG_PTR graphics = 0;
};
const wchar_t *key = L"SomsLaunchOverlay";
Gdiplus::Color color(unsigned rgb, BYTE alpha = 255) {
    return Gdiplus::Color(alpha, (rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
}
void draw(HDC dc, RECT bounds, Overlay &o) {
    using namespace Gdiplus;
    int width = bounds.right, height = bounds.bottom;
    if (width <= 0 || height <= 0) return;
    Bitmap buffer(width, height, PixelFormat32bppARGB);
    Graphics g(&buffer);
    g.Clear(color(o.dark ? 0x11161b : 0xe9e1d5));
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    const float dpi = GetDpiForWindow(o.window) / 96.0f;
    g.ScaleTransform(dpi, dpi);
    const float w = width / dpi, h = height / dpi;
    const double elapsed = double(GetTickCount64() - o.started);
    const float t = o.reduced ? 1.0f : float(fmin(1.0, elapsed / o.reveal));
    const float lift = 24 * (1 - t) * (1 - t);
    auto saved = g.Save();
    g.TranslateTransform(w / 2, h / 2 - 24 + lift);
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
    float brand = o.reduced ? 1 : float(fmax(0.0, fmin(1.0, (elapsed-o.delay)/o.brand)));
    SolidBrush title(color(o.dark ? 0xf0f1f2 : 0x19212a, BYTE(255*brand)));
    SolidBrush subtitle(color(o.dark ? 0xa9adb1 : 0x5b5349, BYTE(255*brand)));
    SolidBrush status(color(o.dark ? 0xa9adb1 : 0x5b5349));
    FontFamily family(L"Segoe UI");
    Font bold(&family,28,FontStyleBold,UnitPixel), normal(&family,12,FontStyleRegular,UnitPixel);
    StringFormat centered; centered.SetAlignment(StringAlignmentCenter);
    g.DrawString(L"SOMS",-1,&bold,RectF(24,h/2+66,w-48,34),&centered,&title);
    g.DrawString(o.chinese ? L"开放聊天，简单即时。" : L"Open chat. Simple and instant.",-1,&normal,RectF(24,h/2+110,w-48,28),&centered,&subtitle);
    const wchar_t *en[] = {L"Preparing",L"Restoring session",L"Requesting remote configuration",L"Preparing interface",L"Startup is taking longer. Still preparing…",L"Startup failed. Close the window and reopen the app."};
    const wchar_t *zh[] = {L"准备中",L"恢复会话",L"请求远端配置",L"整理界面",L"启动时间较长，仍在准备…",L"启动失败，请关闭窗口后重新打开应用。"};
    g.DrawString((o.chinese ? zh : en)[o.stage],-1,&normal,RectF(24,h-48,w-48,32),nullptr,&status);
    Graphics output(dc); output.DrawImage(&buffer,0,0);
}
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
    case WM_PAINT: { PAINTSTRUCT ps; HDC dc=BeginPaint(hwnd,&ps); RECT r; GetClientRect(hwnd,&r); draw(dc,r,*o); EndPaint(hwnd,&ps); return 0; }
    case WM_TIMER:
        if (o->fading) {
            double t = o->reduced ? 1 : fmin(1.0,double(GetTickCount64()-o->fading)/o->fade);
            if (t >= 1) { DestroyWindow(hwnd); return 0; }
            SetLayeredWindowAttributes(hwnd,0,BYTE(255*(1-t)),LWA_ALPHA);
        } else if (GetTickCount64() - o->started >= fmax(o->reveal, o->delay + o->brand)) {
            KillTimer(hwnd,1);
        }
        InvalidateRect(hwnd,nullptr,FALSE); return 0;
    case WM_NCDESTROY:
        KillTimer(hwnd,1);
        if (GetPropW(GetParent(hwnd),key)==hwnd) RemovePropW(GetParent(hwnd),key);
        SetWindowLongPtrW(hwnd,GWLP_USERDATA,0);
        Gdiplus::GdiplusShutdown(o->graphics); delete o;
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
extern "C" bool soms_windows_launch_install(void *raw,bool dark,double reveal,double delay,double brand) {
    HWND parent=static_cast<HWND>(raw);
    WNDCLASSW wc{}; wc.lpfnWndProc=procedure; wc.hInstance=GetModuleHandleW(nullptr); wc.lpszClassName=L"SomsLaunchPresentation"; wc.hCursor=LoadCursorW(nullptr,IDC_ARROW);
    if (!RegisterClassW(&wc) && GetLastError()!=ERROR_CLASS_ALREADY_EXISTS) { fprintf(stderr,"launch RegisterClass error=%lu\n",GetLastError()); return false; }
    auto o=new(std::nothrow) Overlay{}; if (!o) return false;
    o->dark=dark; o->reveal=reveal; o->delay=delay; o->brand=brand;
    BOOL animations=TRUE; SystemParametersInfoW(SPI_GETCLIENTAREAANIMATION,0,&animations,0); o->reduced=!animations;
    o->chinese=PRIMARYLANGID(GetUserDefaultUILanguage())==LANG_CHINESE;
    Gdiplus::GdiplusStartupInput input;
    if (auto status=Gdiplus::GdiplusStartup(&o->graphics,&input,nullptr); status!=Gdiplus::Ok) { fprintf(stderr,"launch GDI startup status=%d\n",int(status)); delete o; return false; }
    RECT r; GetClientRect(parent,&r);
    HWND child=CreateWindowExW(WS_EX_LAYERED,wc.lpszClassName,L"SOMS",WS_CHILD|WS_VISIBLE,0,0,r.right,r.bottom,parent,nullptr,wc.hInstance,o);
    if (!child) { fprintf(stderr,"launch CreateWindow error=%lu\n",GetLastError()); return false; }
    SetPropW(parent,key,child); SetLayeredWindowAttributes(child,0,255,LWA_ALPHA);
    SetWindowSubclass(parent,parentProcedure,1,0); SetTimer(child,1,16,nullptr);
    return true;
}
extern "C" void soms_windows_launch_raise(void *raw) {
    auto child=static_cast<HWND>(GetPropW(static_cast<HWND>(raw),key));
    if(child) SetWindowPos(child,HWND_TOP,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE);
}
extern "C" void soms_windows_launch_present(void *raw,int stage,bool dark,bool finished,double fade) {
    auto child=static_cast<HWND>(GetPropW(static_cast<HWND>(raw),key));
    if(!child) return;
    auto o=reinterpret_cast<Overlay *>(GetWindowLongPtrW(child,GWLP_USERDATA));
    if(!o || o->fading) return;
    o->stage=stage; o->dark=dark;
    if(finished) { o->fade=fade; o->fading=GetTickCount64(); SetTimer(child,1,16,nullptr); }
    InvalidateRect(child,nullptr,FALSE);
}
