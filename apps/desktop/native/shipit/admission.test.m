#import "admission.h"

static const NSTimeInterval TestTimeout = 1;
static const NSTimeInterval ShortTimeout = 0.12;

int main(void) {
  @autoreleasepool {
    __block NSUInteger checks = 0;
    __block NSUInteger operations = 0;
    NSError *error = nil;
    BOOL (^neverRetry)(NSError *) = ^BOOL(NSError *failure) { (void)failure; return NO; };
    RACSignal *released = SSAdmission(^BOOL { return ++checks < 3; }, ^RACSignal *{
      operations++;
      return [RACSignal empty];
    }, neverRetry, TestTimeout);
    if (![released waitUntilCompleted:&error] || error || operations != 1 || checks < 3) return 1;

    NSError *running = [NSError errorWithDomain:@"admission-test" code:1 userInfo:nil];
    BOOL (^retryRunning)(NSError *) = ^BOOL(NSError *failure) { return failure == running; };
    __block NSUInteger races = 0;
    RACSignal *reentered = SSAdmission(^BOOL { return NO; }, ^RACSignal *{
      if (++races < 3) return [RACSignal error:running];
      return [RACSignal return:@42];
    }, retryRunning, TestTimeout);
    id result = [reentered firstOrDefault:nil success:NULL error:&error];
    if (error || ![result isEqual:@42] || races != 3) return 2;

    operations = 0;
    error = nil;
    RACSignal *occupied = SSAdmission(^BOOL { return YES; }, ^RACSignal *{
      operations++;
      return [RACSignal empty];
    }, neverRetry, ShortTimeout);
    if ([occupied waitUntilCompleted:&error] || !error || operations != 0) return 3;

    error = nil;
    NSTimeInterval started = NSProcessInfo.processInfo.systemUptime;
    RACSignal *continuous = SSAdmission(^BOOL { return NO; }, ^RACSignal *{
      return [RACSignal error:running];
    }, retryRunning, ShortTimeout);
    if ([continuous waitUntilCompleted:&error] || !error) return 4;
    if (NSProcessInfo.processInfo.systemUptime - started >= TestTimeout) return 5;

    error = nil;
    RACSignal *failed = SSAdmission(^BOOL { return NO; }, ^RACSignal *{
      return [RACSignal error:running];
    }, neverRetry, TestTimeout);
    if ([failed waitUntilCompleted:&error] || ![error.domain isEqual:SSAdmissionErrorDomain] ||
        error.code != running.code || error.userInfo[NSUnderlyingErrorKey] != running) return 6;

    RACDisposable *subscription = [occupied subscribeCompleted:^{ abort(); }];
    [subscription dispose];
    [NSThread sleepForTimeInterval:ShortTimeout];
    if (operations != 0 || SSAdmissionTimeout <= ShortTimeout) return 7;

    error = nil;
    RACSignal *entered = SSAdmission(^BOOL { return NO; }, ^RACSignal *{
      return [[[RACSignal interval:ShortTimeout * 2 onScheduler:[RACScheduler scheduler]] take:1] mapReplace:@YES];
    }, neverRetry, ShortTimeout);
    if (![[entered firstOrDefault:nil success:NULL error:&error] isEqual:@YES] || error) return 8;

    __block NSUInteger moves = 0;
    error = nil;
    RACSignal *blocked = [occupied then:^RACSignal *{
      moves++;
      return [RACSignal empty];
    }];
    if ([blocked waitUntilCompleted:&error] || moves != 0) return 9;

    error = nil;
    RACSignal *verificationFailure = [failed then:^RACSignal *{
      moves++;
      return [RACSignal empty];
    }];
    if ([verificationFailure waitUntilCompleted:&error] || ![error.domain isEqual:SSAdmissionErrorDomain] ||
        error.userInfo[NSUnderlyingErrorKey] != running || moves != 0) return 10;

    __block NSUInteger validations = 0;
    RACSignal *admitted = SSAdmission(^BOOL { return NO; }, ^RACSignal *{
      validations++;
      return [RACSignal empty];
    }, retryRunning, TestTimeout);
    error = nil;
    RACSignal *postMoveFailure = [[admitted then:^RACSignal *{
      moves++;
      return [RACSignal empty];
    }] then:^RACSignal *{ return [RACSignal error:running]; }];
    if ([postMoveFailure waitUntilCompleted:&error] || error != running || moves != 1 || validations != 1) return 11;
    error = nil;
    RACSignal *moveFailure = [admitted then:^RACSignal *{
      moves++;
      return [RACSignal error:running];
    }];
    if ([moveFailure waitUntilCompleted:&error] || error != running || moves != 2 || validations != 2) return 12;
  }
  return 0;
}
