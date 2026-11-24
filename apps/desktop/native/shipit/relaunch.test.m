#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <preparation.h>
#include <assert.h>
#include <fcntl.h>
#include <unistd.h>

// Exercise the compiled installRequest signal, with its journal and preferences isolated.
static NSString *preparationStore;
#define SSPreparationOpen(label, error) SSPreparationOpenDirectory(preparationStore, error)
#define CFPreferencesSetValue(...) ((void)0)
#define CFPreferencesSynchronize(...) true
#define main originalShipItMain
#include "ShipIt-main.m"
#undef main

static RACSignal *failInstallation(id installer, SEL selector, SQRLShipItRequest *request) {
  assert(request.installationAuthorized && request.launchAfterInstallation);
  return [RACSignal error:[NSError errorWithDomain:SSAdmissionErrorDomain code:EAUTH userInfo:nil]];
}

static void makeDirectory(NSString *path) {
  assert([NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES
    attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    assert(argc == 3 && geteuid() != 0);
    NSString *mode = @(argv[1]);
    NSString *path = @(argv[2]);
    if ([mode isEqual:launchSignal]) {
      // The real launch helper dispatch reached the restored target. Reject a second launch.
      NSString *root = path.stringByDeletingLastPathComponent;
      NSURL *source = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"download/New.app"]];
      NSError *error = nil;
      assert(SSReadinessRead(source, [NSURL fileURLWithPath:path], &error) == SSReadinessFailed && error.code == EAUTH);
      NSString *marker = [root stringByAppendingPathComponent:@"launched"];
      int fd = open(marker.fileSystemRepresentation, O_CREAT | O_EXCL | O_WRONLY, 0600);
      return fd >= 0 && close(fd) == 0 ? EXIT_SUCCESS : EXIT_FAILURE;
    }
    NSURL *source = [NSURL fileURLWithPath:[path stringByAppendingPathComponent:@"download/New.app"] isDirectory:YES];
    NSURL *target = [NSURL fileURLWithPath:[path stringByAppendingPathComponent:@"Old.app"] isDirectory:YES];
    makeDirectory([source.path stringByAppendingPathComponent:@"Contents"]);
    NSString *resources = [target.path stringByAppendingPathComponent:@"Contents/Frameworks/Squirrel.framework/Resources"];
    makeDirectory(resources);
    NSString *helper = [resources stringByAppendingPathComponent:@"ShipIt"];
    if (![mode isEqual:@"replay"])
      assert(symlink(argv[0], helper.fileSystemRepresentation) == 0);
    preparationStore = [path stringByAppendingPathComponent:@"CandidatePreparation"];
    makeDirectory(preparationStore);
    NSString *cleanup = [path stringByAppendingPathComponent:@"DeferredCleanup"];
    makeDirectory(cleanup);
    assert(SSCleanupOpenDirectory(cleanup, NULL));

    Method install = class_getInstanceMethod(SQRLInstaller.class, @selector(installRequest:));
    assert(install);
    method_setImplementation(install, (IMP)failInstallation);
    NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],
      @"candidate":@"prepared", @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@100};
    __block NSUInteger reads = 0;
    RACSignal *requests = [RACSignal defer:^{
      BOOL first = reads++ == 0;
      BOOL authorized = [mode isEqual:@"replay"] || (!first && ![mode isEqual:@"cancel"]);
      NSString *identifier = (!first && [mode isEqual:@"mismatch"]) ? @"fixture.other" : nil;
      return [RACSignal return:[[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target
        bundleIdentifier:identifier launchAfterInstallation:authorized useUpdateBundleName:YES
        binding:binding installationAuthorized:authorized]];
    }];
    installRequest(requests, @"com.scholarseed.test.relaunch");
    dispatch_main();
  }
}
