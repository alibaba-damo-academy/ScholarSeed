// Bounded diagnostics for the in-process Squirrel handoff. No updater authority.
#import <Foundation/Foundation.h>
#import <ReactiveObjC/ReactiveObjC.h>
#import "SQRLDirectoryManager.h"
#import "SQRLShipItLauncher.h"
#include <stdatomic.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static const char * const SSSquirrelLogName = "Squirrel_timing.log";
static const off_t SSSquirrelLogLimit = 64 * 1024;
static const double SSSquirrelMillisecondsPerSecond = 1000.0;

typedef struct {
    unsigned long long identifier;
    NSTimeInterval started;
} SSSquirrelSpan;

// The caller owns the directory FD. Refuse links and concurrent writer contention;
// diagnostics must never wait for a lock or write outside the supplied owner.
static void SSSquirrelAppend(int directory, NSData *bytes) {
    if (directory < 0 || bytes.length > SSSquirrelLogLimit) return;
    struct stat folder;
    if (fstat(directory, &folder) || !S_ISDIR(folder.st_mode) || folder.st_uid != getuid() ||
        (folder.st_mode & (S_IWGRP | S_IWOTH))) return;
    int fd = openat(directory, SSSquirrelLogName, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK, S_IRUSR | S_IWUSR);
    if (fd < 0) return;
    struct stat info;
    if (!fstat(fd, &info) && S_ISREG(info.st_mode) && info.st_uid == getuid() &&
        info.st_nlink == 1 && !(info.st_mode & (S_IWGRP | S_IWOTH)) && !flock(fd, LOCK_EX | LOCK_NB)) {
        if (!fstat(fd, &info) && (info.st_size + (off_t)bytes.length <= SSSquirrelLogLimit || ftruncate(fd, 0) == 0))
            (void)write(fd, bytes.bytes, bytes.length);
        (void)flock(fd, LOCK_UN);
    }
    close(fd);
}

static void SSSquirrelLog(NSString *stage, SSSquirrelSpan span, NSString *event,
                         NSString *result, NSInteger code) {
    @try {
        NSString *line = [NSString stringWithFormat:
            @"[squirrel-timing] schema=1 timestampMs=%.0f pid=%d id=%llu stage=%@ event=%@%@\n",
            NSDate.date.timeIntervalSince1970 * SSSquirrelMillisecondsPerSecond, getpid(), span.identifier,
            stage, event, [event isEqualToString:@"end"] ? [NSString stringWithFormat:
                @" result=%@ elapsedMs=%.3f errorCode=%ld", result,
                (NSProcessInfo.processInfo.systemUptime - span.started) * SSSquirrelMillisecondsPerSecond,
                (long)code] : @""];
        NSLog(@"%@", [line stringByTrimmingCharactersInSet:NSCharacterSet.newlineCharacterSet]);
        // Let Squirrel's directory owner resolve its own cache; never reconstruct
        // ScholarSeed home or accept a path from a feed/environment variable.
        if (!NSBundle.mainBundle.bundleIdentifier) return;
        SQRLDirectoryManager *manager = [[SQRLDirectoryManager alloc]
            initWithApplicationIdentifier:SQRLShipItLauncher.shipItJobLabel];
        NSURL *directory = [[manager storageURL] firstOrDefault:nil];
        int fd = directory ? open(directory.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) : -1;
        if (fd >= 0) {
            SSSquirrelAppend(fd, [line dataUsingEncoding:NSUTF8StringEncoding]);
            close(fd);
        }
    } @catch (__unused NSException *exception) {
        // Preserve the original update result, including when diagnostics fail.
    }
}

static SSSquirrelSpan SSSquirrelBegin(NSString *stage) {
    static atomic_ullong sequence = 0;
    SSSquirrelSpan span = { atomic_fetch_add_explicit(&sequence, 1, memory_order_relaxed) + 1,
                           NSProcessInfo.processInfo.systemUptime };
    SSSquirrelLog(stage, span, @"start", nil, 0);
    return span;
}

static void SSSquirrelEnd(NSString *stage, SSSquirrelSpan span, BOOL success, NSInteger code) {
    SSSquirrelLog(stage, span, @"end", success ? @"success" : @"error", code);
}

// firstValue is only for the upstream's one-result signals. End before forwarding
// that result: downstream flatMap may synchronously run the next expensive stage.
static RACSignal *SSSquirrelTiming(NSString *stage, RACSignal *source, BOOL firstValue) {
    return [RACSignal createSignal:^(id<RACSubscriber> subscriber) {
        const SSSquirrelSpan span = SSSquirrelBegin(stage);
        NSObject *lock = [NSObject new];
        __block BOOL ended = NO;
        void (^finish)(NSString *, NSInteger) = ^(NSString *result, NSInteger code) {
            @synchronized (lock) {
                if (ended) return;
                ended = YES;
                SSSquirrelLog(stage, span, @"end", result, code);
            }
        };
        RACDisposable *subscription = [source subscribeNext:^(id value) {
            if (firstValue) finish(@"success", 0);
            [subscriber sendNext:value];
        } error:^(NSError *error) {
            finish(@"error", error.code);
            [subscriber sendError:error];
        } completed:^{
            finish(@"success", 0);
            [subscriber sendCompleted];
        }];
        return [RACDisposable disposableWithBlock:^{
            [subscription dispose];
            finish(@"disposed", 0);
        }];
    }];
}
