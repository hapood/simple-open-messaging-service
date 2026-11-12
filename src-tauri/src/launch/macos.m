#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <stdbool.h>

// Presentation only. Rust supplies launch state and animation durations; this adapter neither
// reads preferences nor decides when the page is ready. The owning NSWindow retains the overlay.
static char SomsLaunchKey;
static NSColor *SomsColor(unsigned rgb) {
    return [NSColor colorWithSRGBRed:((rgb >> 16) & 255) / 255.0
                              green:((rgb >> 8) & 255) / 255.0
                               blue:(rgb & 255) / 255.0 alpha:1];
}

@interface SomsLaunchLogo : NSView
@end
@implementation SomsLaunchLogo
- (BOOL)isFlipped { return YES; }
- (void)drawRect:(NSRect)dirtyRect {
    [NSGraphicsContext saveGraphicsState];
    NSAffineTransform *transform = [NSAffineTransform transform];
    [transform translateXBy:144 yBy:144];
    [transform scaleBy:288.0 / 108.0 * 0.82];
    [transform translateXBy:-54 yBy:-54];
    [transform concat];
    // Same 108-unit path and 0.82 safe-zone scale as Android's native launch mark.
    NSBezierPath *bubble = [NSBezierPath bezierPath];
    [bubble moveToPoint:NSMakePoint(54, 17)];
    [bubble curveToPoint:NSMakePoint(93, 52) controlPoint1:NSMakePoint(76, 17) controlPoint2:NSMakePoint(93, 32)];
    [bubble curveToPoint:NSMakePoint(55, 86) controlPoint1:NSMakePoint(93, 72) controlPoint2:NSMakePoint(76, 86)];
    [bubble curveToPoint:NSMakePoint(35, 82) controlPoint1:NSMakePoint(48, 86) controlPoint2:NSMakePoint(41, 85)];
    [bubble lineToPoint:NSMakePoint(25, 87)];
    [bubble lineToPoint:NSMakePoint(28, 76)];
    [bubble curveToPoint:NSMakePoint(15, 52) controlPoint1:NSMakePoint(20, 68) controlPoint2:NSMakePoint(15, 61)];
    [bubble curveToPoint:NSMakePoint(54, 17) controlPoint1:NSMakePoint(15, 32) controlPoint2:NSMakePoint(32, 17)];
    [bubble closePath];
    [SomsColor(0xf8f4ec) setFill];
    [bubble fill];
    [SomsColor(0xbbaf9f) setStroke];
    bubble.lineWidth = 1.5;
    [bubble stroke];
    NSBezierPath *mark = [NSBezierPath bezierPath];
    [mark moveToPoint:NSMakePoint(34, 68)];
    [mark lineToPoint:NSMakePoint(34, 40)];
    [mark lineToPoint:NSMakePoint(54, 57)];
    [mark lineToPoint:NSMakePoint(74, 40)];
    [mark lineToPoint:NSMakePoint(74, 68)];
    mark.lineWidth = 8;
    mark.lineCapStyle = NSLineCapStyleRound;
    mark.lineJoinStyle = NSLineJoinStyleRound;
    [SomsColor(0x19212a) setStroke];
    [mark stroke];
    [SomsColor(0x19212a) setFill];
    for (int x = 34; x <= 74; x += 40) {
        for (int y = 40; y <= 68; y += 28) {
            [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x - 6.5, y - 6.5, 13, 13)] fill];
        }
    }
    [SomsColor(0xf04b3a) setFill];
    [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(47, 50, 14, 14)] fill];
    [NSGraphicsContext restoreGraphicsState];
}
@end

@interface SomsLaunchView : NSView
@property(nonatomic, strong) SomsLaunchLogo *logo;
@property(nonatomic, strong) NSView *brand;
@property(nonatomic, strong) NSTextField *title;
@property(nonatomic, strong) NSTextField *tagline;
@property(nonatomic, strong) NSTextField *status;
@property(nonatomic) BOOL chinese;
@property(nonatomic) BOOL dismissing;
@end

@implementation SomsLaunchView
- (BOOL)isFlipped { return YES; }
- (BOOL)isOpaque { return YES; }
- (NSView *)hitTest:(NSPoint)point { return self; }
- (instancetype)initWithFrame:(NSRect)frame {
    if (!(self = [super initWithFrame:frame])) return nil;
    self.wantsLayer = YES;
    self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.chinese = [NSLocale.preferredLanguages.firstObject hasPrefix:@"zh"];
    self.logo = [[SomsLaunchLogo alloc] initWithFrame:NSMakeRect(0, 0, 288, 288)];
    self.logo.wantsLayer = YES;
    self.brand = [[NSView alloc] initWithFrame:NSZeroRect];
    self.brand.wantsLayer = YES;
    self.title = [NSTextField labelWithString:@"SOMS"];
    self.title.font = [NSFont boldSystemFontOfSize:28];
    self.title.alignment = NSTextAlignmentCenter;
    self.tagline = [NSTextField wrappingLabelWithString:self.chinese ? @"开放聊天，简单即时。" : @"Open chat. Simple and instant."];
    self.tagline.font = [NSFont systemFontOfSize:12];
    self.tagline.alignment = NSTextAlignmentCenter;
    self.status = [NSTextField labelWithString:@""];
    self.status.font = [NSFont systemFontOfSize:12];
    [self.brand addSubview:self.title];
    [self.brand addSubview:self.tagline];
    [self addSubview:self.logo];
    [self addSubview:self.brand];
    [self addSubview:self.status];
    [self setAccessibilityElement:YES];
    [self setAccessibilityRole:NSAccessibilityGroupRole];
    [self setAccessibilityLabel:@"SOMS"];
    return self;
}
- (void)layout {
    [super layout];
    CGFloat width = self.bounds.size.width;
    CGFloat height = self.bounds.size.height;
    self.logo.frame = NSMakeRect(round((width - 288) / 2), round((height - 288) / 2) - 24, 288, 288);
    self.brand.frame = NSMakeRect(24, round(height / 2) + 66, MAX(0, width - 48), 72);
    // The brand container uses AppKit's bottom-up coordinates.
    self.title.frame = NSMakeRect(0, 38, self.brand.bounds.size.width, 34);
    self.tagline.frame = NSMakeRect(0, 0, self.brand.bounds.size.width, 28);
    self.status.frame = NSMakeRect(24, height - 48, MAX(0, width - 48), 20);
}
- (void)applyDark:(BOOL)dark stage:(int)stage {
    self.layer.backgroundColor = SomsColor(dark ? 0x11161b : 0xe9e1d5).CGColor;
    self.title.textColor = SomsColor(dark ? 0xf0f1f2 : 0x19212a);
    self.tagline.textColor = SomsColor(dark ? 0xa9adb1 : 0x5b5349);
    self.status.textColor = dark ? SomsColor(0xa9adb1) : [SomsColor(0x19212a) colorWithAlphaComponent:0.67];
    NSArray<NSString *> *labels = self.chinese
        ? @[@"准备中", @"恢复会话", @"请求远端配置", @"整理界面", @"启动时间较长，仍在准备…", @"启动失败，请关闭窗口后重新打开应用。"]
        : @[@"Preparing", @"Restoring session", @"Requesting remote configuration", @"Preparing interface", @"Startup is taking longer. Still preparing…", @"Startup failed. Close the window and reopen the app."];
    self.status.stringValue = labels[MAX(0, MIN(stage, 5))];
}
- (void)viewWillMoveToWindow:(NSWindow *)newWindow {
    if (!newWindow) {
        [self.layer removeAllAnimations];
        [self.logo.layer removeAllAnimations];
        [self.brand.layer removeAllAnimations];
    }
    [super viewWillMoveToWindow:newWindow];
}
@end

void soms_launch_install(void *rawWindow, bool dark, double revealMs, double delayMs, double brandMs) {
    NSCAssert(NSThread.isMainThread, @"launch presentation must run on the main thread");
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    SomsLaunchView *view = [[SomsLaunchView alloc] initWithFrame:window.contentView.bounds];
    [view applyDark:dark stage:0];
    window.backgroundColor = SomsColor(dark ? 0x11161b : 0xe9e1d5);
    objc_setAssociatedObject(window, &SomsLaunchKey, view, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    [window.contentView addSubview:view];
    // Let AppKit's event loop commit the first frame. Forcing display/transaction flush here would
    // re-enter Tao's draw callback while its launch-event lock is still held.
    [view layoutSubtreeIfNeeded];
    if (!NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion) {
        CABasicAnimation *lift = [CABasicAnimation animationWithKeyPath:@"transform.translation.y"];
        lift.fromValue = @24;
        lift.toValue = @0;
        lift.duration = revealMs / 1000;
        lift.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
        [view.logo.layer addAnimation:lift forKey:@"launch-lift"];
        CABasicAnimation *brand = [CABasicAnimation animationWithKeyPath:@"opacity"];
        brand.fromValue = @0;
        brand.toValue = @1;
        brand.beginTime = CACurrentMediaTime() + delayMs / 1000;
        brand.duration = brandMs / 1000;
        brand.fillMode = kCAFillModeBackwards;
        [view.brand.layer addAnimation:brand forKey:@"launch-brand"];
    }
}

void soms_launch_raise(void *rawWindow) {
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    SomsLaunchView *view = objc_getAssociatedObject(window, &SomsLaunchKey);
    if (!view || view.dismissing) return;
    [window.contentView addSubview:view positioned:NSWindowAbove relativeTo:nil];
    [view layoutSubtreeIfNeeded];
}

void soms_launch_present(void *rawWindow, int stage, bool dark, bool finished, double fadeMs) {
    NSCAssert(NSThread.isMainThread, @"launch presentation must run on the main thread");
    NSWindow *window = (__bridge NSWindow *)rawWindow;
    SomsLaunchView *view = objc_getAssociatedObject(window, &SomsLaunchKey);
    if (!view || view.dismissing || !view.window) return;
    [view applyDark:dark stage:stage];
    if (!finished) return;
    view.dismissing = YES;
    // The overlay remains opaque until Rust accepts a renderer-ready fact. No timer reveals content.
    [view.logo.layer removeAllAnimations];
    [view.brand.layer removeAllAnimations];
    window.backgroundColor = SomsColor(dark ? 0x11161b : 0xf3f3f1);
    __weak NSWindow *owner = window;
    [NSAnimationContext runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = NSWorkspace.sharedWorkspace.accessibilityDisplayShouldReduceMotion ? 0 : fadeMs / 1000;
        view.animator.alphaValue = 0;
    } completionHandler:^{
        NSWindow *current = owner;
        if (current && objc_getAssociatedObject(current, &SomsLaunchKey) == view) {
            [view removeFromSuperview];
            objc_setAssociatedObject(current, &SomsLaunchKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        }
    }];
}
