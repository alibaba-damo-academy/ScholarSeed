#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, SSReadinessState) {
    SSReadinessFailed = -1,
    SSReadinessPending = 0,
    SSReadinessReady = 1,
};

// Scheduling acknowledgement only. Never grants permission to install or skip
// ShipIt's private preparation journal, recovery checks or signature validation.
BOOL SSReadinessPublish(NSURL *source, NSURL *target, BOOL success, NSInteger code, NSError **error);
NSInteger SSReadinessRead(NSURL *source, NSURL *target, NSError **error);
BOOL SSReadinessFailedRequest(NSURL *source, NSURL *target);
BOOL SSReadinessPublishBound(NSURL *source, NSURL *target, NSDictionary *binding, BOOL success, NSInteger code, NSError **error);
NSInteger SSReadinessReadBound(NSURL *source, NSURL *target, NSDictionary *binding, NSError **error);
BOOL SSReadinessFailedRequestBound(NSURL *source, NSURL *target, NSDictionary *binding);
NSDictionary *SSReadinessFailureSnapshot(NSURL *source, NSURL *target, NSDictionary *binding, NSInteger code, NSError **error);
BOOL SSReadinessRemove(NSURL *source, NSError **error);
