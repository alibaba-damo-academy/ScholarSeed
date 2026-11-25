#import "handoff.h"
#import "readinesswait.h"
#import "SQRLUpdater.h"
#import "SQRLShipItRequest.h"
#import "SQRLZipArchiver.h"
#include <dlfcn.h>
#include <assert.h>
#include <objc/runtime.h>

@interface SQRLUpdater (HandoffContract)
- (RACSignal *)unarchiveAndPrepareData:(NSData *)data withName:(NSString *)name intoDirectory:(NSURL *)directory;
@end

static void awaitSignal(RACSignal *signal, BOOL expected) {
    __block BOOL finished = NO;
    __block BOOL succeeded = NO;
    [signal subscribeError:^(NSError *error) { finished = YES; }
                 completed:^{ succeeded = YES; finished = YES; }];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
    while (!finished && deadline.timeIntervalSinceNow > 0)
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    assert(finished && succeeded == expected);
}

static void CheckRetryHousekeeping(NSString *root) {
  NSURL *cache = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"retry-cache"] isDirectory:YES];
  NSURL *source = [cache URLByAppendingPathComponent:@"update.failed/ScholarSeed.app" isDirectory:YES];
  NSURL *orphan = [cache URLByAppendingPathComponent:@"update.orphan" isDirectory:YES];
  NSURL *target = [cache URLByAppendingPathComponent:@"installed.app" isDirectory:YES];
  NSFileManager *manager = NSFileManager.defaultManager;
  for (NSURL *directory in @[source, target, orphan])
    assert([manager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
  NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],
    @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"candidate":@"failed-update", @"size":@1};
  SQRLShipItRequest *request = [[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target
    bundleIdentifier:@"fixture.retry" launchAfterInstallation:YES useUpdateBundleName:YES binding:binding installationAuthorized:YES];
  NSURL *state = [cache URLByAppendingPathComponent:@"ShipItState.plist"];
  awaitSignal([request writeUsingURL:[RACSignal return:state]], YES);
  assert(SSReadinessPublishBound(source, target, binding, NO, EIO, NULL));
  NSData *stateBytes = [NSData dataWithContentsOfURL:state];
  assert(stateBytes);

  // Isolate only the directory resolver. Run the framework's real update check,
  // terminating at the missing local feed after its housekeeping has finished.
  assert(setenv("FORCE_APP_IDENTIFIER", "fixture.retry", 1) == 0);
  Method resolver = class_getInstanceMethod(SQRLDirectoryManager.class, @selector(storageURL));
  IMP isolated = imp_implementationWithBlock(^RACSignal *(id self) { return [RACSignal return:cache]; });
  IMP original = method_setImplementation(resolver, isolated);
  NSURLRequest *feed = [NSURLRequest requestWithURL:[cache URLByAppendingPathComponent:@"missing-feed"]];
  SQRLUpdater *updater = [[SQRLUpdater alloc] initWithUpdateRequest:feed];
  [updater setValue:@(SQRLUpdaterStateAwaitingRelaunch) forKey:@"state"];
  awaitSignal([updater.checkForUpdatesCommand execute:nil], NO);
  assert([manager fileExistsAtPath:orphan.path] && SSReadinessFailedRequestBound(source, target, binding));
  assert(updater.state == SQRLUpdaterStateIdle);
  awaitSignal([updater.checkForUpdatesCommand execute:nil], NO);
  assert(![manager fileExistsAtPath:orphan.path]);
  assert(SSReadinessFailedRequestBound(source, target, binding));
  assert([[NSData dataWithContentsOfURL:state] isEqual:stateBytes]);
  method_setImplementation(resolver, original);
  imp_removeBlock(isolated);
  NSLog(@"[squirrel-retry-test] pending relaunch skips cleanup; idle retry preserves exact failed source/ack and removes orphan PASS");
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        assert(argc == 2);
        NSString *root = @(argv[1]);
        Dl_info loaded;
        assert(dladdr((__bridge const void *)SQRLUpdater.class, &loaded));
        assert([@(loaded.dli_fname) hasPrefix:root]);
        assert(!NSBundle.mainBundle.bundleIdentifier); // never write a real application's cache
        CheckRetryHousekeeping(root);
        NSError *expected = [NSError errorWithDomain:@"fixture" code:42 userInfo:nil];
        __block NSError *received = nil;
        [SSSquirrelTiming(@"contract-error", [RACSignal error:expected], NO)
            subscribeError:^(NSError *error) { received = error; }];
        assert(received == expected);
        RACDisposable *never = [SSSquirrelTiming(@"contract-dispose", [RACSignal never], NO) subscribeCompleted:^{}];
        [never dispose];
        __block NSUInteger count = 0;
        RACSignal *value = SSSquirrelTiming(@"contract-value", [RACSignal return:@7], YES);
        [[value flattenMap:^RACSignal *(id next) {
            assert([next isEqual:@7]);
            NSLog(@"CONTRACT_DOWNSTREAM_VALUE");
            count++;
            return [RACSignal empty];
        }] subscribeCompleted:^{}];
        [value subscribeNext:^(id next) { count++; }];
        assert(count == 2);
        [[SSSquirrelTiming(@"contract-terminal", [RACSignal empty], NO) then:^{
            NSLog(@"CONTRACT_DOWNSTREAM_TERMINAL");
            return [RACSignal empty];
        }] subscribeCompleted:^{}];

        NSFileManager *fm = NSFileManager.defaultManager;
        NSString *logDirectory = [root stringByAppendingPathComponent:@"log-fixture"];
        assert([fm createDirectoryAtPath:logDirectory withIntermediateDirectories:NO attributes:nil error:nil]);
        int fd = open(logDirectory.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        NSData *line = [@"bounded\n" dataUsingEncoding:NSUTF8StringEncoding];
        for (NSUInteger i = 0; i < 10000; i++) SSSquirrelAppend(fd, line);
        NSString *log = [logDirectory stringByAppendingPathComponent:@(SSSquirrelLogName)];
        struct stat info;
        assert(!stat(log.fileSystemRepresentation, &info) && info.st_size <= SSSquirrelLogLimit);
        assert([fm removeItemAtPath:log error:nil]);
        NSString *outside = [root stringByAppendingPathComponent:@"outside.txt"];
        assert([@"keep" writeToFile:outside atomically:YES encoding:NSUTF8StringEncoding error:nil]);
        assert(!symlink(outside.fileSystemRepresentation, log.fileSystemRepresentation));
        SSSquirrelAppend(fd, line);
        assert([[NSString stringWithContentsOfFile:outside encoding:NSUTF8StringEncoding error:nil] isEqual:@"keep"]);
        assert(!unlink(log.fileSystemRepresentation));
        assert(!link(outside.fileSystemRepresentation, log.fileSystemRepresentation));
        SSSquirrelAppend(fd, line);
        assert([[NSString stringWithContentsOfFile:outside encoding:NSUTF8StringEncoding error:nil] isEqual:@"keep"]);
        close(fd);

        NSString *input = [root stringByAppendingPathComponent:@"archive-input"];
        NSString *output = [root stringByAppendingPathComponent:@"archive-output"];
        assert([fm createDirectoryAtPath:input withIntermediateDirectories:NO attributes:nil error:nil]);
        assert([fm createDirectoryAtPath:output withIntermediateDirectories:NO attributes:nil error:nil]);
        NSString *payload = [input stringByAppendingPathComponent:@"payload.txt"];
        assert([@"real-ditto" writeToFile:payload atomically:YES encoding:NSUTF8StringEncoding error:nil]);
        NSURL *zip = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"contract.zip"]];
        awaitSignal([SQRLZipArchiver createZipArchiveAtURL:zip fromDirectoryAtURL:[NSURL fileURLWithPath:input]], YES);
        // This intentionally is not a signed app. The real patched preparation
        // must unzip it, then fail bundle discovery without launching ShipIt.
        SQRLUpdater *updater = [SQRLUpdater alloc];
        awaitSignal([updater unarchiveAndPrepareData:[NSData dataWithContentsOfURL:zip]
            withName:@"incoming.zip" intoDirectory:[NSURL fileURLWithPath:output]], NO);
        NSString *extracted = [output stringByAppendingPathComponent:@"archive-input/payload.txt"];
        assert([[NSString stringWithContentsOfFile:extracted encoding:NSUTF8StringEncoding error:nil] isEqual:@"real-ditto"]);
        // Upstream retains the archive when discovery fails before completion.
        assert([fm fileExistsAtPath:[output stringByAppendingPathComponent:@"incoming.zip"]]);
        awaitSignal([updater unarchiveAndPrepareData:[@"invalid zip" dataUsingEncoding:NSUTF8StringEncoding]
            withName:@"broken.zip" intoDirectory:[NSURL fileURLWithPath:output]], NO);
        NSString *readyRoot = [root stringByAppendingPathComponent:@"ready-fixture"];
        assert([fm createDirectoryAtPath:readyRoot withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:nil]);
        NSURL *source = [NSURL fileURLWithPath:[readyRoot stringByAppendingPathComponent:@"source.app"]];
        NSURL *target = [NSURL fileURLWithPath:[readyRoot stringByAppendingPathComponent:@"target.app"]];
        assert([fm createDirectoryAtURL:source withIntermediateDirectories:NO attributes:nil error:nil]);
        assert([fm createDirectoryAtURL:target withIntermediateDirectories:NO attributes:nil error:nil]);
        // Readiness never completes from launch success or the mere source directory.
        awaitSignal(SSReadinessWait(source, target, 0.05), NO);
        __block BOOL readyCompleted = NO;
        RACDisposable *waiting = [SSReadinessWait(source, target, 2) subscribeError:^(NSError *error) { assert(NO); }
            completed:^{ readyCompleted = YES; }];
        assert(!readyCompleted);
        assert(SSReadinessPublish(source, target, YES, 0, NULL));
        NSDate *readyDeadline = [NSDate dateWithTimeIntervalSinceNow:2];
        while (!readyCompleted && readyDeadline.timeIntervalSinceNow > 0)
            [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
        assert(readyCompleted);
        [waiting dispose];
        assert(SSReadinessRemove(source, NULL));
        assert(SSReadinessPublish(source, target, NO, EIO, NULL));
        __block NSError *preparationError = nil;
        [SSRetainPreparationSourceOnError(SSReadinessWait(source, target, 2)) subscribeError:^(NSError *error) { preparationError = error; }];
        assert(preparationError.code == EIO && [preparationError.userInfo[SSPreparationRetainsSourceKey] boolValue]);
        assert([fm fileExistsAtPath:source.path]);
        assert(SSReadinessRemove(source, NULL));
        __block BOOL disposedCompleted = NO;
        RACDisposable *disposed = [SSReadinessWait(source, target, 2) subscribeCompleted:^{ disposedCompleted = YES; }];
        [disposed dispose];
        assert(SSReadinessPublish(source, target, YES, 0, NULL));
        [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
        assert(!disposedCompleted);
        NSLog(@"HANDOFF_CONTRACT_PASSED");
    }
    return 0;
}
