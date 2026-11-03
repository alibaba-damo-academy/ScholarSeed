#import <Foundation/Foundation.h>
#import <ReactiveObjC/ReactiveObjC.h>
#include <errno.h>

static const NSTimeInterval SSAdmissionInterval = 0.05;
static const NSTimeInterval SSAdmissionTimeout = 60;
static NSString *const SSAdmissionErrorDomain = @"com.scholarseed.shipit.admission";
static NSString *const SSAdmissionTargetKey = @"com.scholarseed.shipit.terminal-target";

typedef BOOL (^SSAdmissionOccupied)(void);
typedef RACSignal * (^SSAdmissionOperation)(void);
typedef BOOL (^SSAdmissionRetryable)(NSError *error);

static RACSignal *SSAdmissionAttempt(SSAdmissionOccupied occupied, SSAdmissionOperation operation,
                                     SSAdmissionRetryable retryable, RACScheduler *scheduler,
                                     NSTimeInterval deadline) {
  RACSignal *available = [[[RACSignal interval:SSAdmissionInterval onScheduler:scheduler]
    startWith:NSDate.date] flattenMap:^RACSignal *(id value) {
      (void)value;
      if (NSProcessInfo.processInfo.systemUptime >= deadline)
        return [RACSignal error:[NSError errorWithDomain:SSAdmissionErrorDomain code:ETIMEDOUT userInfo:nil]];
      return occupied() ? [RACSignal empty] : [RACSignal return:@YES];
    }];
  return [[[[available take:1] ignoreValues] then:operation] catch:^RACSignal *(NSError *error) {
    if (!retryable(error)) {
      // This scope ends before target acquisition. The terminal handler must
      // still prove restoration and publish bound evidence before reopening.
      NSError *terminal = [error.domain isEqual:SSAdmissionErrorDomain] ? error :
        [NSError errorWithDomain:SSAdmissionErrorDomain code:error.code userInfo:@{NSUnderlyingErrorKey:error}];
      return [RACSignal error:terminal];
    }
    return [[[[RACSignal interval:SSAdmissionInterval onScheduler:scheduler] take:1] ignoreValues] then:^RACSignal *{
      return SSAdmissionAttempt(occupied, operation, retryable, scheduler, deadline);
    }];
  }];
}

static RACSignal *SSAdmission(SSAdmissionOccupied occupied, SSAdmissionOperation operation,
                              SSAdmissionRetryable retryable, NSTimeInterval timeout) {
  RACScheduler *scheduler = [RACScheduler scheduler];
  return [RACSignal defer:^RACSignal *{
    NSLog(@"[shipit-admission] event=waiting");
    return SSAdmissionAttempt(occupied, operation, retryable, scheduler,
                              NSProcessInfo.processInfo.systemUptime + timeout);
  }];
}
