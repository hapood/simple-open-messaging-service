// Standalone AppKit presentation test. It never starts the application or opens user storage.
#import "macos.m"
#import <WebKit/WebKit.h>

@interface LaunchPaintObserver : NSObject <WKScriptMessageHandler>
@property(nonatomic) BOOL painted;
@end
@implementation LaunchPaintObserver
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    self.painted = YES;
}
@end

static void runLoop(double seconds) {
    NSDate *end = [NSDate dateWithTimeIntervalSinceNow:seconds];
    while ([end timeIntervalSinceNow] > 0) {
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:end];
    }
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        NSWindow *window = [[NSWindow alloc]
            initWithContentRect:NSMakeRect(0, 0, 1200, 800)
            styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskResizable
            backing:NSBackingStoreBuffered defer:NO];
        window.releasedWhenClosed = NO;
        soms_launch_install((__bridge void *)window, false, 320, 100, 220);
        SomsLaunchView *view = objc_getAssociatedObject(window, &SomsLaunchKey);
        NSCAssert(view && view.superview == window.contentView, @"native layer must precede WebKit");
        NSCAssert(view.logo.frame.size.width == 288, @"match Android logo canvas");
        [window orderFront:nil];
        runLoop(0.4);
        // A newly attached white renderer cannot replace or cover the original launch layer.
        NSView *renderer = [[NSView alloc] initWithFrame:window.contentView.bounds];
        renderer.wantsLayer = YES;
        renderer.layer.backgroundColor = NSColor.whiteColor.CGColor;
        [window.contentView addSubview:renderer];
        soms_launch_raise((__bridge void *)window);
        NSCAssert(window.contentView.subviews.lastObject == view, @"overlay must cover renderer initialization");
        soms_launch_present((__bridge void *)window, 4, false, false, 180);
        NSCAssert(view.alphaValue == 1 && !view.dismissing, @"slow startup must remain covered");
        if (argc > 1) {
            [view layoutSubtreeIfNeeded];
            NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
            [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
            [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}]
                writeToFile:[NSString stringWithUTF8String:argv[1]] atomically:YES];
        }
        soms_launch_present((__bridge void *)window, 3, true, false, 180);
        NSCAssert(objc_getAssociatedObject(window, &SomsLaunchKey) == view, @"theme updates must preserve geometry");
        [window setContentSize:NSMakeSize(600, 640)];
        [view layoutSubtreeIfNeeded];
        NSCAssert(view.frame.size.width == 600, @"overlay must follow window resizing");
        soms_launch_present((__bridge void *)window, 3, true, true, 180);
        runLoop(0.4);
        NSCAssert(!objc_getAssociatedObject(window, &SomsLaunchKey), @"ready removes the native layer");
        NSCAssert(renderer.superview == window.contentView, @"handoff must preserve renderer");
        // Exercise a real WebKit renderer with a deliberately blocked JavaScript thread. The native
        // layer is independent and stays installed until that document reports two rendering turns.
        soms_launch_install((__bridge void *)window, false, 320, 100, 220);
        view = objc_getAssociatedObject(window, &SomsLaunchKey);
        LaunchPaintObserver *observer = [LaunchPaintObserver new];
        WKWebViewConfiguration *configuration = [WKWebViewConfiguration new];
        [configuration.userContentController addScriptMessageHandler:observer name:@"painted"];
        WKWebView *webview = [[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:configuration];
        [window.contentView addSubview:webview];
        soms_launch_raise((__bridge void *)window);
        [webview loadHTMLString:@"<body style='background:#11161b'><h1>Ready</h1><script>const start=performance.now();while(performance.now()-start<750){}requestAnimationFrame(()=>requestAnimationFrame(()=>window.webkit.messageHandlers.painted.postMessage(true)))</script>" baseURL:nil];
        runLoop(0.2);
        NSCAssert(!observer.painted && !view.dismissing && view.alphaValue == 1, @"busy WebKit must not uncover white");
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
        while (!observer.painted && deadline.timeIntervalSinceNow > 0) runLoop(0.1);
        NSCAssert(observer.painted, @"real WebKit must report a painted page");
        NSCAssert(window.contentView.subviews.lastObject == view, @"native cover survives renderer loading");
        soms_launch_present((__bridge void *)window, 3, false, true, 180);
        runLoop(0.4);
        NSCAssert(!objc_getAssociatedObject(window, &SomsLaunchKey), @"real WebKit handoff must complete");
        [configuration.userContentController removeScriptMessageHandlerForName:@"painted"];
        [webview removeFromSuperview];
        // Late completion after close must not revive the overlay or dereference a destroyed owner.
        soms_launch_install((__bridge void *)window, true, 320, 100, 220);
        soms_launch_present((__bridge void *)window, 3, true, true, 180);
        [window close];
        runLoop(0.4);
        NSLog(@"PASS: native-first frame, stacking, slow launch, theme, resizing, busy WebKit, fade and close");
    }
    return 0;
}
