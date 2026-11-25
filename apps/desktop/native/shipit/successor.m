#import "successor.h"
#import "SQRLUpdater.h"
#import "SQRLShipItLauncher.h"
#import <AppKit/AppKit.h>
#import <ReactiveObjC/ReactiveObjC.h>
#include <errno.h>

@interface SQRLUpdater (SSSuccessorSupport)
- (RACSignal *)ss_authorizeRelaunch;
@end

@interface SSAlternateLauncher : SQRLShipItLauncher
@end

@implementation SSAlternateLauncher
+ (NSString *)shipItJobLabel {
  return [[super shipItJobLabel] stringByAppendingString:@".next"];
}
@end

@interface SSSuccessorUpdater : SQRLUpdater <SSSuccessor>
@property (nonatomic) BOOL alternate;
@property (nonatomic) BOOL checking;
@property (nonatomic) BOOL ready;
@property (nonatomic, copy) void (^completion)(NSError *);
@end

// Accessed only on the AppKit main thread. A disposed check retains its slot
// until completion because RACCommand may continue doing work without a subscriber.
static SSSuccessorUpdater *SSSuccessors[2];

@implementation SSSuccessorUpdater
- (Class)ss_launcherClass {
  return self.alternate ? SSAlternateLauncher.class : SQRLShipItLauncher.class;
}

- (void)finishCheck:(NSError *)error {
  self.checking = NO;
  void (^completion)(NSError *) = self.completion;
  self.completion = nil;
  if (!completion) {
    SSSuccessors[self.alternate] = nil;
    return;
  }
  self.ready = !error;
  completion(error);
}

- (void)beginCheck {
  if (!self.completion) {
    [self finishCheck:nil];
    return;
  }
  __block BOOL downloaded = NO;
  [[[self.checkForUpdatesCommand execute:nil] deliverOn:RACScheduler.mainThreadScheduler]
    subscribeNext:^(id update) {
      downloaded = update != nil;
    } error:^(NSError *error) {
      [self finishCheck:error];
    } completed:^{
      BOOL ready = downloaded && self.state == SQRLUpdaterStateAwaitingRelaunch;
      [self finishCheck:ready ? nil : [NSError errorWithDomain:NSPOSIXErrorDomain code:ENODATA userInfo:nil]];
    }];
}

- (BOOL)ss_installSuccessor:(NSError **)error {
  if (!NSThread.isMainThread || !NSApp || !self.ready || SSSuccessors[self.alternate] != self) {
    if (error) *error = [NSError errorWithDomain:NSPOSIXErrorDomain code:ESTALE userInfo:nil];
    return NO;
  }
  // The original request read, bound readiness check and coordinated grant write
  // complete before asking AppKit to quit. Report grant failures to the caller.
  if (![[self ss_authorizeRelaunch] waitUntilCompleted:error]) return NO;
  self.ready = NO;
  [NSApp terminate:self];
  return YES;
}

- (void)ss_disposeSuccessor {
  if (!NSThread.isMainThread || SSSuccessors[self.alternate] != self) return;
  self.completion = nil;
  self.ready = NO;
  if (!self.checking) SSSuccessors[self.alternate] = nil;
}
@end

@interface SQRLUpdater (SSSuccessorFactory) <SSSuccessorFactory>
@end

@implementation SQRLUpdater (SSSuccessorFactory)
+ (id<SSSuccessor>)ss_prepareSuccessor:(NSURL *)feed alternate:(BOOL)alternate
                            completion:(void (^)(NSError *))completion {
  if (!NSThread.isMainThread || !completion || SSSuccessors[alternate]) return nil;
  // Accept only the capability URL emitted by squirrelFeed. The new request
  // has no interaction header, so background preparation cannot elevate.
  NSString *address = feed.absoluteString;
  if (!address.length || [address rangeOfString:@"^http://127\\.0\\.0\\.1:[1-9][0-9]{0,4}/[a-f0-9]{64}/feed$"
                                  options:NSRegularExpressionSearch].length != address.length ||
      feed.port.unsignedIntegerValue > UINT16_MAX) return nil;
  SSSuccessorUpdater *updater = [[SSSuccessorUpdater alloc] initWithUpdateRequest:[NSURLRequest requestWithURL:feed]];
  if (!updater) return nil;
  updater.alternate = alternate;
  updater.completion = completion;
  updater.checking = YES;
  SSSuccessors[alternate] = updater;
  dispatch_async(dispatch_get_main_queue(), ^{ [updater beginCheck]; });
  return updater;
}
@end
