#import "binding.h"
#import "readiness.h"
#import "SQRLUpdater.h"
#import "SQRLShipItRequest.h"
#import <AppKit/AppKit.h>
#import <ReactiveObjC/ReactiveObjC.h>
#include <assert.h>
#include <dlfcn.h>

@interface SQRLUpdater (GrantContract)
- (RACSignal *)relaunchToInstallUpdate;
@end
@interface GrantUpdater : SQRLUpdater
@property (nonatomic, strong) NSURL *fixtureState;
@end
@implementation GrantUpdater
- (RACSignal *)shipItStateURL { return [RACSignal return:self.fixtureState]; }
@end

static void CheckGrant(NSURL *state, SQRLShipItRequest *prepared, SQRLShipItRequest *current, BOOL expected) {
  assert(!NSApp);
  NSError *error = nil;
  assert([[current writeUsingURL:[RACSignal return:state]] waitUntilCompleted:&error] && !error);
  GrantUpdater *updater = [GrantUpdater alloc]; updater.fixtureState = state;
  [updater setValue:prepared forKey:@"scholarseedRequest"];
  __block NSError *failure = nil;
  RACDisposable *subscription = [[updater relaunchToInstallUpdate] subscribeError:^(NSError *value) { failure = value; }];
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2];
  BOOL authorized = NO;
  while (!failure && !authorized && deadline.timeIntervalSinceNow > 0) {
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfURL:state] options:0 error:NULL];
    authorized = [json[@"installationAuthorized"] boolValue];
    if (!authorized) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  [subscription dispose];
  assert(!NSApp && authorized == expected && (expected || failure));
}
int main(int argc, const char **argv) {
  @autoreleasepool {
    assert(argc == 2 && !NSApp && !NSBundle.mainBundle.bundleIdentifier);
    NSString *root = @(argv[1]);
    Dl_info loaded; assert(dladdr((__bridge const void *)SQRLUpdater.class, &loaded));
    assert([@(loaded.dli_fname) hasPrefix:root.stringByDeletingLastPathComponent]);
    NSURL *source = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"request/New.app"]];
    NSURL *target = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"live/Old.app"]];
    for (NSURL *url in @[source, target]) assert([NSFileManager.defaultManager createDirectoryAtURL:url withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    NSURL *state = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"state.json"]];
    NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0], @"candidate":@"candidate-a", @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@100};
    SQRLShipItRequest *request = [[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target bundleIdentifier:@"fixture.none" launchAfterInstallation:NO useUpdateBundleName:YES binding:binding installationAuthorized:NO];
    CheckGrant(state, request, request, NO);
    assert(SSReadinessPublishBound(source, target, binding, YES, 0, NULL));
    CheckGrant(state, request, request, YES);
    CheckGrant(state, nil, request, NO);
    SQRLShipItRequest *changed = [[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target bundleIdentifier:@"fixture.other" launchAfterInstallation:NO useUpdateBundleName:YES binding:binding installationAuthorized:NO];
    CheckGrant(state, request, changed, NO);
    changed = [[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target bundleIdentifier:@"fixture.none" launchAfterInstallation:NO useUpdateBundleName:NO binding:binding installationAuthorized:NO];
    CheckGrant(state, request, changed, NO);
    NSMutableDictionary *other = [binding mutableCopy]; other[@"candidate"] = @"candidate-b";
    assert(SSReadinessPublishBound(source, target, other, YES, 0, NULL));
    CheckGrant(state, request, request, NO);
    assert(SSReadinessPublishBound(source, target, binding, NO, ECANCELED, NULL));
    CheckGrant(state, request, request, NO);
    NSLog(@"[squirrel-grant-test] real request write, exact ready requirement and terminal priority PASS");
  }
  return 0;
}
