#import "handoff.h"
#import "readinesswait.h"
#import "SQRLUpdater.h"
#import "SQRLZipArchiver.h"
#include <dlfcn.h>
#include <assert.h>

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

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        assert(argc == 2);
        NSString *root = @(argv[1]);
        Dl_info loaded;
        assert(dladdr((__bridge const void *)SQRLUpdater.class, &loaded));
        assert([@(loaded.dli_fname) hasPrefix:root]);
        assert(!NSBundle.mainBundle.bundleIdentifier); // never write a real application's cache
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
