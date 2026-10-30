#import "timing.h"
#import <ReactiveObjC/RACDisposable.h>
#include <stdio.h>

int main(void) {
    @autoreleasepool {
        __block NSUInteger completed = 0;
        [SSShipItTiming(@"success", [RACSignal empty]) subscribeCompleted:^{ completed++; }];
        NSError *expected = [NSError errorWithDomain:@"timing-test" code:7 userInfo:nil];
        __block NSError *observed = nil;
        [SSShipItTiming(@"error", [RACSignal error:expected]) subscribeError:^(NSError *error) { observed = error; }];
        RACDisposable *pending = [SSShipItTiming(@"dispose", [RACSignal never]) subscribeCompleted:^{ abort(); }];
        [pending dispose];
        __block NSUInteger subscriptions = 0;
        RACSignal *multiple = SSShipItTiming(@"multiple", [RACSignal defer:^{
            subscriptions++;
            return [RACSignal empty];
        }]);
        [multiple subscribeCompleted:^{ completed++; }];
        [multiple subscribeCompleted:^{ completed++; }];
        [[SSShipItTiming(@"terminal", [RACSignal empty]) concat:[RACSignal defer:^{
            fprintf(stderr, "DOWNSTREAM_TERMINAL\n");
            return [RACSignal empty];
        }]] subscribeCompleted:^{ completed++; }];
        __block id value = nil;
        [[[RACSignal defer:^{
            SSShipItSpan span = SSShipItBegin(@"value");
            id result = @42;
            SSShipItEnd(@"value", span, YES, 0);
            return [RACSignal return:result];
        }] flattenMap:^RACSignal *(id next) {
            fprintf(stderr, "DOWNSTREAM_NEXT\n");
            return [RACSignal return:next];
        }] subscribeNext:^(id next) { value = next; }];
        if (completed != 4 || subscriptions != 2 || observed != expected || ![value isEqual:@42]) return 1;
    }
    return 0;
}
