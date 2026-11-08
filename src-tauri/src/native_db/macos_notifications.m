#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#include <stdint.h>
#include <stdbool.h>

typedef void (*SomsCompletion)(void *, const char *);
extern void soms_macos_notification_tapped(int32_t threadId, const char *notificationId);
extern void soms_macos_notification_dismissed(int32_t threadId, const char *notificationId);
static NSString *const SomsMessageCategory = @"soms-message";
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
    BOOL tapped = [response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier];
    BOOL dismissed = [response.actionIdentifier isEqualToString:UNNotificationDismissActionIdentifier];
    if ((tapped || dismissed) && [identifier hasPrefix:SomsPrefix]) {
        NSNumber *thread = response.notification.request.content.userInfo[@"threadId"];
        long long value = [thread isKindOfClass:NSNumber.class] ? thread.longLongValue : 0;
        if (value > 0 && value <= INT32_MAX) {
            if (tapped) soms_macos_notification_tapped((int32_t)value, identifier.UTF8String);
            else soms_macos_notification_dismissed((int32_t)value, identifier.UTF8String);
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
        UNNotificationCategory *category = [UNNotificationCategory
            categoryWithIdentifier:SomsMessageCategory actions:@[] intentIdentifiers:@[]
            options:UNNotificationCategoryOptionCustomDismissAction];
        [UNUserNotificationCenter.currentNotificationCenter setNotificationCategories:
            [NSSet setWithObject:category]];
    });
}

// Rust dispatches this adapter on the main thread after validating the login and revision.
void soms_macos_badge_set_label(const char *label) {
    NSApplication.sharedApplication.dockTile.badgeLabel = label ? [NSString stringWithUTF8String:label] : nil;
}

void soms_macos_notifications_status(void *context, void (*completion)(void *, int32_t)) {
    [UNUserNotificationCenter.currentNotificationCenter getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *settings) {
        completion(context, (int32_t)settings.authorizationStatus);
    }];
}

void soms_macos_notifications_authorize(void *context, SomsCompletion completion) {
    [UNUserNotificationCenter.currentNotificationCenter
        requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound | UNAuthorizationOptionBadge)
        completionHandler:^(BOOL granted, NSError *error) {
            completion(context, error ? error.localizedDescription.UTF8String :
                       (granted ? NULL : "notification permission denied"));
        }];
}

void soms_macos_notification_post(int32_t threadId, const char *notificationId,
                                  const char *title, const char *body,
                                  bool silent, void *context, SomsCompletion completion) {
    @autoreleasepool {
        UNMutableNotificationContent *content = [UNMutableNotificationContent new];
        content.categoryIdentifier = SomsMessageCategory;
        content.title = [NSString stringWithUTF8String:title];
        content.body = [NSString stringWithUTF8String:body];
        if (!silent) content.sound = UNNotificationSound.defaultSound;
        content.userInfo = @{@"threadId": @(threadId)};
        NSString *identifier = [NSString stringWithUTF8String:notificationId];
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:identifier
                                                                           content:content trigger:nil];
        [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request
            withCompletionHandler:^(NSError *error) {
                completion(context, error ? error.localizedDescription.UTF8String : NULL);
            }];
    }
}

void soms_macos_notification_remove(const char *notificationId) {
    NSString *identifier = [NSString stringWithUTF8String:notificationId];
    UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
    [center removePendingNotificationRequestsWithIdentifiers:@[identifier]];
    [center removeDeliveredNotificationsWithIdentifiers:@[identifier]];
}

// Return delivered message facts only. Rust owns validation and duplicate selection.
void soms_macos_notifications_current(void *context, void (*completion)(void *, const char *, const char *)) {
    [UNUserNotificationCenter.currentNotificationCenter getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> *notifications) {
        NSMutableArray *cards = [NSMutableArray new];
        for (UNNotification *notification in notifications) {
            UNNotificationRequest *request = notification.request;
            if (![request.identifier hasPrefix:SomsPrefix]) continue;
            [cards addObject:@{@"identifier": request.identifier,
                               @"threadId": request.content.userInfo[@"threadId"] ?: NSNull.null}];
        }
        NSError *error = nil;
        NSData *data = [NSJSONSerialization dataWithJSONObject:cards options:0 error:&error];
        NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
        completion(context, json.UTF8String, error ? error.localizedDescription.UTF8String : NULL);
    }];
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
