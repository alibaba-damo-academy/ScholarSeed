#import "readiness.h"
#include <assert.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/wait.h>

static NSURL *Make(NSString *root, NSString *name) {
    NSURL *url = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:name]];
    assert([NSFileManager.defaultManager createDirectoryAtURL:url withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    return url;
}
int main(int argc, const char **argv) {
    @autoreleasepool {
        assert(argc == 2);
        NSString *root = @(argv[1]);
        NSURL *source = Make(root, @"source/App.app"), *target = Make(root, @"live/App.app");
        NSString *ack = [source.path.stringByDeletingLastPathComponent stringByAppendingPathComponent:@".scholarseed-prepare.plist"];
        NSError *error = nil;
        assert(SSReadinessRead(source, target, &error) == SSReadinessPending);
        assert(SSReadinessPublish(source, target, YES, 0, &error));
        assert(SSReadinessRead(source, target, &error) == SSReadinessReady);
        assert(SSReadinessPublish(source, target, NO, 42, &error));
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed && error.code == 42);
        assert(SSReadinessPublish(source, target, YES, 0, &error));
        NSString *saved = [target.path stringByAppendingString:@".saved"];
        assert(rename(target.path.UTF8String, saved.UTF8String) == 0);
        Make(root, @"live/App.app");
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed);
        assert(rmdir(target.path.UTF8String) == 0 && rename(saved.UTF8String, target.path.UTF8String) == 0);
        assert(SSReadinessRead(source, target, &error) == SSReadinessReady);
        saved = [source.path stringByAppendingString:@".saved"];
        assert(rename(source.path.UTF8String, saved.UTF8String) == 0);
        Make(root, @"source/App.app");
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed);
        assert(!SSReadinessRemove(source, &error));
        assert(rmdir(source.path.UTF8String) == 0 && rename(saved.UTF8String, source.path.UTF8String) == 0);
        assert(SSReadinessRemove(source, &error));
        assert(SSReadinessRead(source, target, &error) == SSReadinessPending);
        assert(SSReadinessRemove(source, &error));
        NSLog(@"[readiness-test] pending ready failure identity replacement removal PASS");

        assert([@"malformed" writeToFile:ack atomically:NO encoding:NSUTF8StringEncoding error:NULL]);
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed);
        assert(!SSReadinessRemove(source, &error));
        assert(unlink(ack.UTF8String) == 0);
        NSString *external = [root stringByAppendingPathComponent:@"external"];
        assert([@"untouched" writeToFile:external atomically:NO encoding:NSUTF8StringEncoding error:NULL]);
        assert(symlink(external.UTF8String, ack.UTF8String) == 0);
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed);
        assert(!SSReadinessRemove(source, &error));
        assert(SSReadinessPublish(source, target, YES, 0, &error));
        assert([[NSString stringWithContentsOfFile:external encoding:NSUTF8StringEncoding error:NULL] isEqual:@"untouched"]);
        assert(SSReadinessRead(source, target, &error) == SSReadinessReady);
        assert(chmod(ack.UTF8String, 0666) == 0);
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed);
        assert(chmod(ack.UTF8String, 0644) == 0);
        NSString *alias = [root stringByAppendingPathComponent:@"ack-hardlink"];
        assert(link(ack.UTF8String, alias.UTF8String) == 0);
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed);
        assert(unlink(alias.UTF8String) == 0);
        assert(SSReadinessRemove(source, &error));
        assert([[NSMutableData dataWithLength:4097] writeToFile:ack atomically:NO]);
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed);
        assert(unlink(ack.UTF8String) == 0);
        assert(mkfifo(ack.UTF8String, 0600) == 0);
        assert(SSReadinessRead(source, target, &error) == SSReadinessFailed);
        assert(unlink(ack.UTF8String) == 0);
        NSLog(@"[readiness-test] malformed symlink hardlink writable oversized FIFO PASS");
        NSString *next = [source.path.stringByDeletingLastPathComponent stringByAppendingPathComponent:@".scholarseed-prepare.next"];
        pid_t child = fork(); assert(child >= 0);
        if (child == 0) {
            int partial = open(next.UTF8String, O_WRONLY | O_CREAT | O_EXCL | O_EXLOCK, 0600);
            assert(partial >= 0 && write(partial, "partial", 7) == 7 && fsync(partial) == 0);
            _exit(0); // Crash before rename: lock released, partial leaf remains.
        }
        int status; assert(waitpid(child, &status, 0) == child && WEXITSTATUS(status) == 0);
        assert(SSReadinessPublish(source, target, YES, 0, &error));
        assert(access(next.UTF8String, F_OK) != 0);
        assert(SSReadinessRead(source, target, &error) == SSReadinessReady);
        int empty = open(next.UTF8String, O_WRONLY | O_CREAT | O_EXCL, 0600); assert(empty >= 0); close(empty);
        assert(SSReadinessRemove(source, &error));
        assert(access(next.UTF8String, F_OK) != 0 && access(ack.UTF8String, F_OK) != 0);
        empty = open(next.UTF8String, O_WRONLY | O_CREAT | O_EXCL, 0600); assert(empty >= 0); close(empty);
        assert(SSReadinessRemove(source, &error)); // Missing ack still reclaims partial next.
        assert(access(next.UTF8String, F_OK) != 0);
        assert(symlink(external.UTF8String, next.UTF8String) == 0);
        assert(!SSReadinessPublish(source, target, YES, 0, &error));
        assert(!SSReadinessRemove(source, &error));
        assert([[NSString stringWithContentsOfFile:external encoding:NSUTF8StringEncoding error:NULL] isEqual:@"untouched"]);
        assert(unlink(next.UTF8String) == 0);
        int active = open(next.UTF8String, O_WRONLY | O_CREAT | O_EXCL | O_EXLOCK, 0600); assert(active >= 0);
        assert(!SSReadinessPublish(source, target, YES, 0, &error));
        assert(!SSReadinessRemove(source, &error));
        close(active);
        assert(SSReadinessRemove(source, &error));
        NSLog(@"[readiness-test] partial-crash-republish empty-remove absent-ack symlink-next active-writer PASS");
    }
    return 0;
}
