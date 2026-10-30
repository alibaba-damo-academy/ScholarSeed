#import "preparation.h"
#import "readiness.h"
#include <assert.h>
#include <unistd.h>

static NSURL *Bundle(NSString *path) {
  NSURL *url = [NSURL fileURLWithPath:path];
  assert([NSFileManager.defaultManager createDirectoryAtURL:[url URLByAppendingPathComponent:@"Contents"] withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
  return url;
}
int main(int argc, const char **argv) {
  @autoreleasepool {
    assert(argc == 2 && geteuid() != 0);
    NSString *root = @(argv[1]);
    NSMutableSet *parents = [NSMutableSet set];
    for (NSString *name in @[@"same", @"renamed", @"conflict", @"source-change"]) {
      NSString *fixture = [root stringByAppendingPathComponent:name];
      NSURL *source = Bundle([fixture stringByAppendingPathComponent:@"request/New.app"]);
      NSURL *target = Bundle([fixture stringByAppendingPathComponent:@"live/Old.app"]);
      NSString *store = [fixture stringByAppendingPathComponent:@"journal"];
      assert([NSFileManager.defaultManager createDirectoryAtPath:store withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
      assert(SSPreparationOpenDirectory(store, NULL));
      NSURL *candidate = SSPreparationCopy(source, target, nil, NULL); assert(candidate);
      [parents addObject:candidate.path.stringByDeletingLastPathComponent];
      NSInteger code = 0;
      assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureNone);
      NSURL *actual = target;
      BOOL renamed = ![name isEqual:@"same"] && ![name isEqual:@"source-change"];
      if (renamed) {
        actual = [target.URLByDeletingLastPathComponent URLByAppendingPathComponent:@"New.app"];
        assert(rename(target.path.fileSystemRepresentation, actual.path.fileSystemRepresentation) == 0);
      }
      assert(SSPreparationRecordFailure(source, actual, nil, ECANCELED, NULL));
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
      assert(!SSPreparationCopy(source, target, nil, NULL));
      assert(!SSPreparationValidate(source, target, nil, candidate, NULL));
      assert(!SSPreparationRetire(source, target, NULL));
      NSURL *otherSource = Bundle([fixture stringByAppendingPathComponent:@"other/New.app"]);
      NSURL *otherTarget = Bundle([fixture stringByAppendingPathComponent:@"other-live/Other.app"]);
      if (renamed) {
        assert(SSPreparationRecoverFailure(otherSource, otherTarget, nil, &code, NULL) == SSPreparationFailureInvalid);
        assert(!SSPreparationCopy(otherSource, otherTarget, nil, NULL));
        assert([NSFileManager.defaultManager fileExistsAtPath:candidate.path]);
      }
      if ([name isEqual:@"conflict"]) {
        Bundle(target.path);
        assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureInvalid);
        assert([NSFileManager.defaultManager fileExistsAtPath:actual.path]);
        assert([NSFileManager.defaultManager removeItemAtURL:target error:NULL]);
      }
      if ([name isEqual:@"source-change"]) {
        NSString *saved = [source.path stringByAppendingString:@".saved"];
        assert(rename(source.path.fileSystemRepresentation, saved.fileSystemRepresentation) == 0);
        Bundle(source.path);
        assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureInvalid);
        assert([NSFileManager.defaultManager removeItemAtURL:source error:NULL]);
        assert(rename(saved.fileSystemRepresentation, source.path.fileSystemRepresentation) == 0);
      }
      assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureRestored && code == ECANCELED);
      if (renamed) assert(![NSFileManager.defaultManager fileExistsAtPath:actual.path]);
      NSString *next = [source.path.stringByDeletingLastPathComponent stringByAppendingPathComponent:@".scholarseed-prepare.next"];
      assert(symlink(target.path.fileSystemRepresentation, next.fileSystemRepresentation) == 0);
      assert(!SSReadinessPublish(source, target, NO, code, NULL));
      assert(!SSReadinessFailedRequest(source, target));
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nil, &code, NULL) == SSPreparationFailureInvalid);
      assert(!SSPreparationCopy(otherSource, otherTarget, nil, NULL));
      SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
      assert(SSPreparationRecoverFailure(source, target, nil, &code, NULL) == SSPreparationFailureRestored);
      assert(unlink(next.fileSystemRepresentation) == 0);
      assert(SSReadinessPublish(source, target, NO, code, NULL));
      assert(SSReadinessRead(source, target, NULL) == SSReadinessFailed);
      assert(SSReadinessFailedRequest(source, target));
      assert([NSFileManager.defaultManager fileExistsAtPath:target.path]);
      assert(!SSPreparationCopy(source, target, nil, NULL));
      assert(SSPreparationRecoverFailure(otherSource, otherTarget, nil, &code, NULL) == SSPreparationFailureNone);
      NSURL *nextCandidate = SSPreparationCopy(otherSource, otherTarget, nil, NULL); assert(nextCandidate);
      [parents addObject:nextCandidate.path.stringByDeletingLastPathComponent];
      assert(!SSPreparationCopy(source, target, nil, NULL));
      assert([NSFileManager.defaultManager fileExistsAtPath:nextCandidate.path]);
      SSPreparationClose();
      NSLog(@"[shipit-terminal-test] %@ durable restore publish retry PASS", name);
    }
    for (NSString *parent in parents) if ([NSFileManager.defaultManager fileExistsAtPath:parent]) assert([NSFileManager.defaultManager removeItemAtPath:parent error:NULL]);
  }
  return 0;
}
