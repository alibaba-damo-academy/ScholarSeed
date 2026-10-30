#import <Foundation/Foundation.h>
#import <ReactiveObjC/ReactiveObjC.h>
#import "readiness.h"

static NSString * const SSPreparationRetainsSourceKey = @"SSPreparationRetainsSource";
static const NSTimeInterval SSPreparationTimeout = 10 * 60;
static const NSTimeInterval SSPreparationPollInterval = 0.1;

// Notification controls only exit timing. The installer independently validates
// its private ready journal and the candidate signature after application exit.
static RACSignal *SSReadinessWaitBound(NSURL *source, NSURL *target, NSDictionary *binding, NSTimeInterval timeout) {
    RACScheduler *scheduler = [RACScheduler scheduler];
    RACSignal *poll = [[RACSignal interval:SSPreparationPollInterval onScheduler:scheduler] startWith:@0];
    return [[[[[poll flattenMap:^RACSignal *(id _) {
        NSError *error = nil;
        NSInteger state = SSReadinessReadBound(source, target, binding, &error);
        if (state == SSReadinessReady) return [RACSignal return:@YES];
        if (state == SSReadinessFailed) return [RACSignal error:error ?: [NSError errorWithDomain:NSPOSIXErrorDomain code:EIO userInfo:nil]];
        return [RACSignal empty];
    }] take:1] ignoreValues] timeout:timeout onScheduler:scheduler] setNameWithFormat:@"candidate preparation ready"];
}
static inline RACSignal *SSReadinessWait(NSURL *source, NSURL *target, NSTimeInterval timeout) {
    return SSReadinessWaitBound(source, target, nil, timeout);
}

static RACSignal *SSRetainPreparationSourceOnError(RACSignal *signal) {
    return [signal catch:^RACSignal *(NSError *error) {
        NSMutableDictionary *info = [error.userInfo mutableCopy] ?: [NSMutableDictionary dictionary];
        info[SSPreparationRetainsSourceKey] = @YES;
        return [RACSignal error:[NSError errorWithDomain:error.domain code:error.code userInfo:info]];
    }];
}
