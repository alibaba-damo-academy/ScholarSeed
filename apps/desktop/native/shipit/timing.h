// Diagnostic-only wrapper: preserve the source signal, subscription and terminal result.
#import <Foundation/Foundation.h>
#import <ReactiveObjC/RACSignal.h>
#import <ReactiveObjC/RACDisposable.h>
#import <ReactiveObjC/RACSubscriber.h>
#import <ReactiveObjC/RACSignal+Operations.h>
#include <stdatomic.h>

static void SSShipItTimingLog(NSString *stage, unsigned long long identifier,
                            NSString *event, NSString *result,
                            NSTimeInterval started, NSInteger errorCode) {
    @try {
        if ([event isEqualToString:@"start"]) {
            NSLog(@"[shipit-timing] schema=1 id=%llu stage=%@ event=start", identifier, stage);
        } else {
            const double elapsedMs = (NSProcessInfo.processInfo.systemUptime - started) * 1000.0;
            NSLog(@"[shipit-timing] schema=1 id=%llu stage=%@ event=end result=%@ elapsedMs=%.3f errorCode=%ld",
                  identifier, stage, result, elapsedMs, (long)errorCode);
        }
    } @catch (__unused NSException *exception) {
        // Diagnostics must never replace the installer's result.
    }
}

typedef struct {
    unsigned long long identifier;
    NSTimeInterval started;
} SSShipItSpan;

static SSShipItSpan SSShipItBegin(NSString *stage) {
    static atomic_ullong sequence = 0;
    SSShipItSpan span = {
        atomic_fetch_add_explicit(&sequence, 1, memory_order_relaxed) + 1,
        NSProcessInfo.processInfo.systemUptime
    };
    SSShipItTimingLog(stage, span.identifier, @"start", nil, span.started, 0);
    return span;
}

static void SSShipItEnd(NSString *stage, SSShipItSpan span, BOOL success, NSInteger code) {
    SSShipItTimingLog(stage, span.identifier, @"end", success ? @"success" : @"error", span.started, code);
}

// Only for completion-only signals. Value-producing native operations must end
// before sendNext, since a synchronous downstream flatMap can do expensive work.
static RACSignal *SSShipItTiming(NSString *stage, RACSignal *source) {
    return [RACSignal createSignal:^(id<RACSubscriber> subscriber) {
        const SSShipItSpan span = SSShipItBegin(stage);
        NSObject *lock = [NSObject new];
        __block BOOL ended = NO;
        void (^finish)(NSString *, NSInteger) = ^(NSString *result, NSInteger errorCode) {
            @synchronized (lock) {
                if (ended) return;
                ended = YES;
                SSShipItTimingLog(stage, span.identifier, @"end", result, span.started, errorCode);
            }
        };
        // Log before forwarding the terminal event: downstream concat/then may
        // synchronously run another expensive stage before finally is called.
        RACDisposable *subscription = [[[source doCompleted:^{
            finish(@"success", 0);
        }] doError:^(NSError *error) {
            finish(@"error", error.code);
        }] subscribe:subscriber];
        return [RACDisposable disposableWithBlock:^{
            [subscription dispose];
            finish(@"disposed", 0);
        }];
    }];
}
