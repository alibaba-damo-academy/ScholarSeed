#import "binding.h"
#import "readiness.h"
#import "successor.h"
#import "SQRLUpdater.h"
#import "SQRLDirectoryManager.h"
#import "SQRLShipItRequest.h"
#import "SQRLShipItLauncher.h"
#import <AppKit/AppKit.h>
#import <ReactiveObjC/ReactiveObjC.h>
#include <assert.h>
#include <dlfcn.h>
#include <objc/runtime.h>

@interface SQRLUpdater (GrantContract) <SSSuccessorFactory>
- (RACSignal *)relaunchToInstallUpdate;
- (RACSignal *)launchShipItWithRequiredPrivilege:(BOOL)privileged;
- (RACSignal *)shipItStateURL;
- (RACSignal *)ss_authorizeRelaunch;
- (Class)ss_launcherClass;
@end
@interface GrantUpdater : SQRLUpdater
@property (nonatomic, strong) NSURL *fixtureState;
@end
@implementation GrantUpdater
- (RACSignal *)shipItStateURL { return [RACSignal return:self.fixtureState]; }
@end

static NSUInteger Submissions;
static BOOL LastSubmissionPrivileged;

static RACSignal *RecordSubmission(id receiver, SEL selector, BOOL privileged) {
  (void)receiver; (void)selector;
  Submissions++;
  LastSubmissionPrivileged = privileged;
  return [RACSignal empty];
}

static void CheckInteraction(void) {
  GrantUpdater *updater = [GrantUpdater alloc];
  assert([updater respondsToSelector:@selector(launchShipItWithRequiredPrivilege:)]);
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"http://127.0.0.1/feed"]];
  [updater setValue:[request copy] forKey:@"updateRequest"];
  NSError *error = nil;
  assert(![[updater launchShipItWithRequiredPrivilege:YES] waitUntilCompleted:&error]);
  assert(error.code == EACCES && Submissions == 0);
  assert([[updater launchShipItWithRequiredPrivilege:NO] waitUntilCompleted:NULL]);
  assert(Submissions == 1 && !LastSubmissionPrivileged);
  [request setValue:@"true" forHTTPHeaderField:@"X-ScholarSeed-Update-Interaction"];
  [updater setValue:[request copy] forKey:@"updateRequest"];
  assert(![[updater launchShipItWithRequiredPrivilege:YES] waitUntilCompleted:&error]);
  assert(error.code == EACCES && Submissions == 1);
  [request setValue:@"1" forHTTPHeaderField:@"X-ScholarSeed-Update-Interaction"];
  [updater setValue:[request copy] forKey:@"updateRequest"];
  assert([[updater launchShipItWithRequiredPrivilege:YES] waitUntilCompleted:NULL]);
  assert(Submissions == 2 && LastSubmissionPrivileged);
}

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
static void WaitFor(NSString *event, BOOL (^observed)(void)) {
  const NSTimeInterval deadline = NSProcessInfo.processInfo.systemUptime + 10;
  while (!observed()) {
    if (NSProcessInfo.processInfo.systemUptime >= deadline) {
      NSLog(@"[squirrel-slot-test] timed out waiting for %@", event);
      abort();
    }
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
}

static id<SSSuccessor> AcquireAlternateAfterDisposal(NSURL *feed, NSString *event, void (^completion)(NSError *)) {
  __block id<SSSuccessor> successor;
  WaitFor(event, ^BOOL {
    successor = [SQRLUpdater ss_prepareSuccessor:feed alternate:YES completion:completion];
    return successor != nil;
  });
  return successor;
}

static void CheckSlots(NSString *root, SQRLShipItRequest *request) {
  assert(setenv("FORCE_APP_IDENTIFIER", "fixture.slots", 1) == 0);
  Method resolver = class_getInstanceMethod(SQRLDirectoryManager.class, @selector(storageURL));
  IMP isolated = imp_implementationWithBlock(^RACSignal *(SQRLDirectoryManager *manager) {
    NSURL *directory = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:manager.applicationIdentifier] isDirectory:YES];
    assert([NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:NULL]);
    return [RACSignal return:directory];
  });
  IMP original = method_setImplementation(resolver, isolated);
  NSString *token = [@"c" stringByPaddingToLength:64 withString:@"c" startingAtIndex:0];
  NSURL *feed = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:1/%@/feed", token]];
  __block NSUInteger errors = 0;
  void (^failed)(NSError *) = ^(NSError *error) { assert(error); errors++; };
  assert(![SQRLUpdater ss_prepareSuccessor:[NSURL URLWithString:@"file:///tmp/feed"] alternate:YES completion:failed]);
  SQRLUpdater<SSSuccessor> *next = (id)[SQRLUpdater ss_prepareSuccessor:feed alternate:YES completion:failed];
  assert(next && ![next ss_installSuccessor:NULL]);
  assert(![SQRLUpdater ss_prepareSuccessor:feed alternate:YES completion:failed]);
  SQRLUpdater *primary = [SQRLUpdater alloc];
  NSURL *primaryState = [[primary shipItStateURL] first];
  NSURL *nextState = [[next shipItStateURL] first];
  assert([[primary ss_launcherClass] isEqual:SQRLShipItLauncher.class]);
  assert([[[next ss_launcherClass] shipItJobLabel] isEqual:@"fixture.slots.ShipIt.next"]);
  assert([primaryState.path isEqual:[root stringByAppendingPathComponent:@"fixture.slots.ShipIt/ShipItState.plist"]]);
  assert([nextState.path isEqual:[root stringByAppendingPathComponent:@"fixture.slots.ShipIt.next/ShipItState.plist"]]);

  // Commit B using the original updater while D's independent check is outstanding.
  assert([[request writeUsingURL:[RACSignal return:primaryState]] waitUntilCompleted:NULL]);
  [primary setValue:request forKey:@"scholarseedRequest"];
  __block NSError *primaryError = nil;
  RACDisposable *install = [[primary relaunchToInstallUpdate] subscribeError:^(NSError *error) { primaryError = error; }];
  __block SQRLShipItRequest *selected;
  WaitFor(@"primary installation grant", ^BOOL {
    selected = [[SQRLShipItRequest readUsingURL:[RACSignal return:primaryState]] first];
    return primaryError != nil || selected.installationAuthorized;
  });
  [install dispose];
  assert(!primaryError && selected.installationAuthorized && [selected.binding isEqual:request.binding]);
  WaitFor(@"successor check failure", ^BOOL { return errors > 0; });
  assert(errors == 1);
  assert(![NSFileManager.defaultManager fileExistsAtPath:nextState.path] && ![next ss_installSuccessor:NULL]);
  [next ss_disposeSuccessor];
  // A fresh pair of bound ready requests exercises the other selection. Use the
  // same coordinated grant write as installSuccessor without quitting this test.
  assert([[request writeUsingURL:[RACSignal return:primaryState]] waitUntilCompleted:NULL]);
  NSData *retained = [NSData dataWithContentsOfURL:primaryState];
  assert(retained);
  NSURL *source = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"download-d/New.app"] isDirectory:YES];
  assert([NSFileManager.defaultManager createDirectoryAtURL:source withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
  NSMutableDictionary *binding = [request.binding mutableCopy];
  binding[@"candidate"] = @"candidate-d";
  binding[@"requestId"] = [@"d" stringByPaddingToLength:64 withString:@"d" startingAtIndex:0];
  SQRLShipItRequest *successor = [[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:request.targetBundleURL
    bundleIdentifier:request.bundleIdentifier launchAfterInstallation:NO useUpdateBundleName:YES binding:binding installationAuthorized:NO];
  assert([[successor writeUsingURL:[RACSignal return:nextState]] waitUntilCompleted:NULL]);
  assert(SSReadinessPublishBound(source, request.targetBundleURL, binding, YES, 0, NULL));
  SQRLUpdater<SSSuccessor> *winner = (id)[SQRLUpdater ss_prepareSuccessor:feed alternate:YES completion:failed];
  assert(winner);
  [winner setValue:request forKey:@"scholarseedRequest"];
  assert(![[winner ss_authorizeRelaunch] waitUntilCompleted:NULL]);
  [winner setValue:successor forKey:@"scholarseedRequest"];
  assert([[winner ss_authorizeRelaunch] waitUntilCompleted:NULL]);
  SQRLShipItRequest *chosen = [[SQRLShipItRequest readUsingURL:[RACSignal return:nextState]] first];
  assert(chosen.installationAuthorized && chosen.launchAfterInstallation && [chosen.binding isEqual:binding]);
  assert([[NSData dataWithContentsOfURL:primaryState] isEqual:retained]);
  assert(![[[SQRLShipItRequest readUsingURL:[RACSignal return:primaryState]] first] installationAuthorized]);
  [winner ss_disposeSuccessor];
  // Disposing an unfinished request suppresses its callback, without touching B.
  id<SSSuccessor> disposed = AcquireAlternateAfterDisposal(feed, @"winner slot release", failed);
  [disposed ss_disposeSuccessor];
  __block NSError *probeError = nil;
  id<SSSuccessor> probe = AcquireAlternateAfterDisposal(feed, @"unfinished successor slot release",
    ^(NSError *error) { probeError = error; });
  WaitFor(@"replacement check failure", ^BOOL { return probeError != nil; });
  [probe ss_disposeSuccessor];
  assert(errors == 1 && ![disposed ss_installSuccessor:NULL]);
  method_setImplementation(resolver, original);
  imp_removeBlock(isolated);
  NSLog(@"[squirrel-slot-test] independent state and job label, B grant during D check, isolated failure and disposal PASS");
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    assert(argc == 2 && !NSApp && !NSBundle.mainBundle.bundleIdentifier);
    NSString *root = @(argv[1]);
    Dl_info loaded; assert(dladdr((__bridge const void *)SQRLUpdater.class, &loaded));
    assert([@(loaded.dli_fname) hasPrefix:root.stringByDeletingLastPathComponent]);
    // Isolate launchd for the lifetime of this process, including asynchronous slot work.
    Method submit = class_getClassMethod(SQRLShipItLauncher.class, @selector(launchPrivileged:));
    assert(submit);
    method_setImplementation(submit, (IMP)RecordSubmission);
    CheckInteraction();
    NSURL *source = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"request/New.app"]];
    NSURL *target = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"live/Old.app"]];
    for (NSURL *url in @[source, target]) assert([NSFileManager.defaultManager createDirectoryAtURL:url withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    NSURL *state = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"state.json"]];
    NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0], @"candidate":@"candidate-a", @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@100};
    SQRLShipItRequest *request = [[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target bundleIdentifier:@"fixture.none" launchAfterInstallation:NO useUpdateBundleName:YES binding:binding installationAuthorized:NO];
    CheckGrant(state, request, request, NO);
    assert(SSReadinessPublishBound(source, target, binding, YES, 0, NULL));
    CheckGrant(state, request, request, YES);
    CheckSlots(root, request);
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
    NSLog(@"[squirrel-grant-test] privilege interaction, real request write, exact ready requirement and terminal priority PASS");
  }
  return 0;
}
