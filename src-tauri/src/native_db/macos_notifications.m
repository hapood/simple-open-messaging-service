#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#include <stdint.h>
#include <stdbool.h>

typedef void (*SomsCompletion)(void *, const char *);
extern void soms_macos_notification_tapped(int32_t threadId);
static NSString *const SomsPrefix = @"soms-thread-";

@interface SomsNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@end

@implementation SomsNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    if (@available(macOS 11.0, *)) {
        completion(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList |
                   UNNotificationPresentationOptionSound);
    } else {
        completion(UNNotificationPresentationOptionAlert | UNNotificationPresentationOptionSound);
    }
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
didReceiveNotificationResponse:(UNNotificationResponse *)response
         withCompletionHandler:(void (^)(void))completion {
    NSString *identifier = response.notification.request.identifier;
    if ([response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier] &&
        [identifier hasPrefix:SomsPrefix]) {
        NSString *suffix = [identifier substringFromIndex:SomsPrefix.length];
        long long value = suffix.longLongValue;
        if (value > 0 && value <= INT32_MAX &&
            [suffix isEqualToString:[NSString stringWithFormat:@"%lld", value]]) {
            soms_macos_notification_tapped((int32_t)value);
        }
    }
    completion();
}
@end

void soms_macos_notifications_init(void) {
    static SomsNotificationDelegate *delegate;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        delegate = [SomsNotificationDelegate new];
        UNUserNotificationCenter.currentNotificationCenter.delegate = delegate;
    });
}

void soms_macos_notifications_authorize(void *context, SomsCompletion completion) {
    [UNUserNotificationCenter.currentNotificationCenter
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
        completionHandler:^(BOOL granted, NSError *error) {
            completion(context, error ? error.localizedDescription.UTF8String :
                       (granted ? NULL : "notification permission denied"));
        }];
}

void soms_macos_notification_post(int32_t threadId, const char *title, const char *body,
                                  bool silent, void *context, SomsCompletion completion) {
    @autoreleasepool {
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.title = [NSString stringWithUTF8String:title];
        content.body = [NSString stringWithUTF8String:body];
        if (!silent) content.sound = UNNotificationSound.defaultSound;
        NSString *identifier = [SomsPrefix stringByAppendingFormat:@"%d", threadId];
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier
                                                                           content:content trigger:nil];
        [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request
            withCompletionHandler:^(NSError *error) {
                completion(context, error ? error.localizedDescription.UTF8String : NULL);
            }];
    }
}

void soms_macos_notification_remove(int32_t threadId) {
    NSString *identifier = [SomsPrefix stringByAppendingFormat:@"%d", threadId];
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    [center removePendingNotificationRequestsWithIdentifiers:@[identifier]];
    [center removeDeliveredNotificationsWithIdentifiers:@[identifier]];
}

void soms_macos_notifications_clear(void *context, SomsCompletion completion) {
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    [center getPendingNotificationRequestsWithCompletionHandler:^(NSArray<UNNotificationRequest *> *requests) {
        NSMutableArray<NSString *> *ids = [NSMutableArray new];
        for (UNNotificationRequest *request in requests)
            if ([request.identifier hasPrefix:SomsPrefix]) [ids addObject:request.identifier];
        [center removePendingNotificationRequestsWithIdentifiers:ids];
        [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
            NSMutableArray<NSString *> *delivered = [NSMutableArray new];
            for (UNNotification *notification in notifications)
                if ([notification.request.identifier hasPrefix:SomsPrefix])
                    [delivered addObject:notification.request.identifier];
            [center removeDeliveredNotificationsWithIdentifiers:delivered];
            completion(context, NULL);
        }];
    }];
}
