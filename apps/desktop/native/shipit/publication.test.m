#import <Foundation/Foundation.h>
#import "preparation.h"
#import "readiness.h"
#import "binding.h"
#import "cleanup.h"
#import "observation.h"
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <errno.h>
#include <limits.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <mach/mach_time.h>

static int PublicationClose(int descriptor);
static int PublicationOpenAt(int directory, const char *name, int flags, ...);
static int PublicationSync(int descriptor);
static ssize_t PublicationWrite(int descriptor, const void *bytes, size_t length);
static char *PublicationRealpath(const char *path, char *resolved);
#define close PublicationClose
#define openat PublicationOpenAt
#define fsync PublicationSync
#define write PublicationWrite
#define realpath PublicationRealpath
#import "preparation.m"
#undef close
#undef openat
#undef fsync
#undef write
#undef realpath

typedef NS_ENUM(NSUInteger, PublicationFault) {
  PublicationChildClose,
  PublicationParentClose,
  PublicationFileClose,
  PublicationFileSync,
  PublicationDirectorySync,
  PublicationWriteClose,
  PublicationCandidateCapture,
  PublicationCandidateOpen,
};
static PublicationFault Fault;
static BOOL Armed, Fired, Counting;
static NSUInteger Matches, MatchToFail, Passed;
static NSDictionary *ClosingIdentity;
static BOOL WriteFailed, SuppressWriteClose;
static NSUInteger PriorDirectoryCount;

static int PublicationOpenAt(int directory, const char *name, int flags, ...) {
  if (Armed && !Fired && Fault == PublicationCandidateOpen && directory == SSPreparationFD &&
      (flags & O_DIRECTORY) && !strncmp(name, SSPreparationPrefix.UTF8String, SSPreparationPrefix.length)) {
    Fired = YES; errno = EMFILE; return -1;
  }
  if (!(flags & O_CREAT)) return openat(directory, name, flags);
  va_list args;
  va_start(args, flags);
  int mode = va_arg(args, int);
  va_end(args);
  return openat(directory, name, flags, mode);
}
static int PublicationClose(int descriptor) {
  int saved = errno;
  struct stat info;
  BOOL observed = fstat(descriptor, &info) == 0;
  BOOL matching = observed && S_ISDIR(info.st_mode) && [Identity(info) isEqual:ClosingIdentity];
  if ((Armed || Counting) && matching) Matches++;
  BOOL fail = Armed && !Fired && ((matching && Matches == MatchToFail && (Fault == PublicationChildClose || Fault == PublicationParentClose)) ||
    ((Fault == PublicationFileClose || (Fault == PublicationWriteClose && WriteFailed && !SuppressWriteClose)) && observed && S_ISREG(info.st_mode) && descriptor != SSPreparationLockFD));
  errno = saved;
  if (fail) { Fired = YES; errno = EIO; return -1; }
  return close(descriptor);
}
static int PublicationSync(int descriptor) {
  int saved = errno;
  struct stat info;
  BOOL regular = fstat(descriptor, &info) == 0 && S_ISREG(info.st_mode);
  BOOL fail = Armed && !Fired && ((Fault == PublicationDirectorySync && descriptor == SSPreparationFD) ||
    (Fault == PublicationFileSync && regular && descriptor != SSPreparationLockFD));
  errno = saved;
  if (fail) { Fired = YES; errno = EIO; return -1; }
  return fsync(descriptor);
}
static ssize_t PublicationWrite(int descriptor, const void *bytes, size_t length) {
  if (Armed && Fault == PublicationWriteClose) { WriteFailed = YES; errno = ENOSPC; return -1; }
  return write(descriptor, bytes, length);
}
static void Check(BOOL value, NSString *label) {
  if (!value) NSLog(@"[shipit-publication-fault] FAIL %@", label);
  assert(value); Passed++;
}
static NSURL *FixtureBundle(NSString *path) {
  NSURL *url = [NSURL fileURLWithPath:path];
  assert([NSFileManager.defaultManager createDirectoryAtURL:[url URLByAppendingPathComponent:@"Contents"] withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
  return url;
}
static NSDictionary *FixtureBinding(NSString *character) {
  return @{@"schema":@1, @"requestId":[character stringByPaddingToLength:64 withString:character startingAtIndex:0],
    @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@1, @"candidate":@"fault-publication"};
}
static NSData *Bytes(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path]; assert(data); return data;
}
static NSDictionary *DiskJournal(NSString *path) {
  return [NSPropertyListSerialization propertyListWithData:Bytes(path) options:0 format:NULL error:NULL];
}
static NSSet *CandidateDirectories(NSString *store) {
  NSArray *names = [NSFileManager.defaultManager contentsOfDirectoryAtPath:store error:NULL];
  assert(names);
  return [NSSet setWithArray:[names filteredArrayUsingPredicate:
    [NSPredicate predicateWithFormat:@"SELF BEGINSWITH %@", SSPreparationPrefix]]];
}
static char *PublicationRealpath(const char *path, char *resolved) {
  if (Armed && !Fired && Fault == PublicationCandidateCapture &&
      !strcmp(path, SSPreparationObservedDirectory.fileSystemRepresentation) &&
      CandidateDirectories(SSPreparationObservedDirectory).count > PriorDirectoryCount) {
    Fired = YES; errno = ENOENT; return NULL;
  }
  return realpath(path, resolved);
}
static void CheckCandidatePublication(NSString *root, BOOL rebuild, PublicationFault fault) {
  NSFileManager *manager = NSFileManager.defaultManager;
  NSURL *source = FixtureBundle([root stringByAppendingPathComponent:@"source/New.app"]);
  NSURL *target = FixtureBundle([root stringByAppendingPathComponent:@"target/Old.app"]);
  NSString *store = [root stringByAppendingPathComponent:@"store"];
  assert(mkdir(store.fileSystemRepresentation, S_IRWXU) == 0 && SSPreparationOpenDirectory(store, NULL));
  NSString *sibling = [SSPreparationPrefix stringByAppendingString:NSUUID.UUID.UUIDString];
  assert(mkdir([store stringByAppendingPathComponent:sibling].fileSystemRepresentation, S_IRWXU) == 0);
  NSString *journal = [store stringByAppendingPathComponent:SSPreparationJournal];
  NSDictionary *binding = FixtureBinding(@"d");
  NSURL *candidate = nil;
  NSData *oldJournal = nil;
  if (rebuild) {
    NSString *member = @"Contents/py.typed";
    assert([[NSData data] writeToURL:[source URLByAppendingPathComponent:member] atomically:NO]);
    candidate = SSPreparationCopy(source, target, binding, NULL);
    assert(candidate && [manager removeItemAtURL:[candidate URLByAppendingPathComponent:member] error:NULL]);
    assert(SSPreparationBeginOwnership(source, target, binding, candidate, NULL));
    oldJournal = Bytes(journal);
  }
  NSSet *before = CandidateDirectories(store);
  PriorDirectoryCount = before.count;
  NSError *error = nil;
  Fault = fault;
  SuppressWriteClose = YES;
  Armed = YES;
  NSURL *result = rebuild ? SSPreparationRebuildCandidate(source, target, binding, candidate, &error)
                          : SSPreparationCopy(source, target, binding, &error);
  Armed = NO;
  BOOL writeFault = fault == PublicationWriteClose;
  int expectedCode = EIO;
  if (fault == PublicationCandidateOpen) expectedCode = EMFILE;
  if (fault == PublicationCandidateCapture) expectedCode = ENOENT;
  if (writeFault) expectedCode = ENOSPC;
  Check(!result && (writeFault ? WriteFailed : Fired) && [error.domain isEqual:NSPOSIXErrorDomain] &&
        error.code == expectedCode, @"candidate publication propagates its first I/O error");
  NSSet *after = CandidateDirectories(store);
  if (fault == PublicationDirectorySync) {
    NSDictionary *record = DiskJournal(journal)[@"record"];
    NSDictionary *directory = (rebuild ? record[@"rebuild"] : record)[@"directory"];
    NSString *path = directory[@"path"];
    Check(path && ![before containsObject:path.lastPathComponent] && [Capture(path, NO) isEqual:directory] &&
          [after isEqual:[before setByAddingObject:path.lastPathComponent]], @"an already published directory remains owned after sync failure");
  } else {
    Check([before isEqual:after], @"an unpublished candidate leaves no empty directory and all siblings survive");
    Check(rebuild ? [Bytes(journal) isEqual:oldJournal] : ![manager fileExistsAtPath:journal],
          @"a pre-publication failure leaves the previous journal unchanged");
  }
  if (fault == PublicationCandidateOpen || fault == PublicationCandidateCapture || writeFault) {
    NSURL *retried = rebuild ? SSPreparationRebuildCandidate(source, target, binding, candidate, NULL)
                             : SSPreparationCopy(source, target, binding, NULL);
    Check(retried && [DiskJournal(journal)[@"record"][@"attempts"] isEqual:@1],
          @"a failed unpublished attempt can be retried in the same process without spending a copy");
  } else {
    Check(SSPreparationUncertaintyCode() == EIO, @"a sync failure keeps the writer fenced");
  }
}
static void LockHeld(NSString *store) {
  pid_t child = fork(); assert(child >= 0);
  if (child == 0) {
    close(SSPreparationFD); close(SSPreparationLockFD);
    int descriptor = open([[store stringByAppendingPathComponent:@"lock"] fileSystemRepresentation], O_RDWR | O_NOFOLLOW);
    if (descriptor < 0) _exit(2);
    int result = flock(descriptor, LOCK_EX | LOCK_NB), code = errno;
    close(descriptor);
    _exit(result != 0 && (code == EWOULDBLOCK || code == EAGAIN) ? 0 : 3);
  }
  int status = 0; assert(waitpid(child, &status, 0) == child);
  Check(WIFEXITED(status) && WEXITSTATUS(status) == 0, @"uncertain qualification retains its kernel lock");
}
static void Exercise(NSString *root, PublicationFault fault) {
  fprintf(stderr, "[shipit-publication-fault] stage=exercise case=%lu\n", (unsigned long)fault); fflush(stderr);
  Fault = fault; Passed = 0;
  NSURL *source = FixtureBundle([root stringByAppendingPathComponent:@"source/New.app"]), *target = FixtureBundle([root stringByAppendingPathComponent:@"target/Old.app"]);
  NSURL *nextSource = FixtureBundle([root stringByAppendingPathComponent:@"next/Next.app"]), *nextTarget = FixtureBundle([root stringByAppendingPathComponent:@"next-target/Next.app"]);
  NSString *store = [root stringByAppendingPathComponent:@"journal"], *journal = [store stringByAppendingPathComponent:@"journal.plist"];
  assert([NSFileManager.defaultManager createDirectoryAtPath:store withIntermediateDirectories:NO attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
  NSDictionary *binding = FixtureBinding(@"a"), *nextBinding = FixtureBinding(@"c");
  Check(SSPreparationOpenDirectory(store, NULL), @"open isolated journal");
  NSURL *candidate = SSPreparationCopy(source, target, binding, NULL);
  Check(candidate != nil && SSPreparationRecordFailure(source, target, binding, ECANCELED, NULL), @"create exact failed request");
  __block NSUInteger launches = 0;
  NSInteger code = 0;
  if (fault == PublicationWriteClose) {
    NSError *error = nil;
    Armed = YES; SuppressWriteClose = YES;
    Check(!SSPreparationFinishFailure(source, target, binding, YES, ^BOOL { return NO; }, ^BOOL { launches++; return YES; }, &error) && error.code == ENOSPC, @"ordinary write failure remains a business failure");
    Check(SSPreparationUncertaintyCode() == 0 && !Fired, @"successful cleanup close does not poison qualification");
    Check(launches == 0 && !SSReadinessFailedRequestBound(source, target, binding), @"ordinary failed publication never launches");
    Armed = NO; SuppressWriteClose = NO; WriteFailed = NO;
  }
  if (fault == PublicationChildClose || fault == PublicationParentClose) {
    Check(SSPreparationFinishFailure(source, target, binding, NO, nil, nil, NULL), @"commit terminal receipt before close fault");
    Check(SSReadinessRemove(source, NULL), @"remove only fixture compatibility notification");
    ClosingIdentity = SSPreparationRecord[@"directory"][fault == PublicationChildClose ? @"item" : @"parent"];
    Counting = YES; Matches = 0;
    Check(SSPreparationRecoverFailure(nextSource, nextTarget, nextBinding, &code, NULL) == SSPreparationFailureNone, @"healthy observation establishes aux close callsite");
    Counting = NO; MatchToFail = Matches;
    Check(MatchToFail > 0, @"observed final matching aux close");
    fprintf(stderr, "[shipit-publication-fault] stage=arm case=%lu\n", (unsigned long)fault); fflush(stderr);
    Matches = 0; Armed = YES;
    Check(SSPreparationRecoverFailure(nextSource, nextTarget, nextBinding, &code, NULL) == SSPreparationFailureInvalid, @"aux close fault rejects observation");
  } else {
    NSError *error = nil;
    fprintf(stderr, "[shipit-publication-fault] stage=arm case=%lu\n", (unsigned long)fault); fflush(stderr);
    Armed = YES;
    Check(!SSPreparationFinishFailure(source, target, binding, YES, ^BOOL { return NO; }, ^BOOL { launches++; return YES; }, &error), @"publication IO fault reports failure");
    if (fault == PublicationWriteClose) Check(error.code == ENOSPC, @"write business error remains available after cleanup close failure");
  }
  Armed = NO;
  Check(Fired, @"one compile-time fixture fault fired");
  Check(SSPreparationCloseUncertain, @"uncertain IO poisons qualification until process death");
  Check(SSPreparationUncertaintyCode() == EIO, @"read-only getter retains first uncertain errno");
  Check(launches == 0 && !SSReadinessFailedRequestBound(source, target, binding), @"failed publication never notifies or launches");
  BOOL durable = DiskJournal(journal)[@"record"][@"failure"][@"publication"] != nil;
  Check(durable == (fault == PublicationChildClose || fault == PublicationParentClose || fault == PublicationDirectorySync), @"post-rename failure preserves actual complete disk state");
  NSData *before = Bytes(journal);
  Check(SSPreparationRecoverFailure(nextSource, nextTarget, nextBinding, &code, NULL) == SSPreparationFailureInvalid, @"fault removal cannot restore recovery qualification");
  Check(SSPreparationCopy(nextSource, nextTarget, nextBinding, NULL) == nil, @"fault removal cannot restart candidate copying");
  Check(!SSPreparationValidate(source, target, binding, candidate, NULL), @"uncertain qualification cannot validate");
  Check(!SSPreparationBeginOwnership(source, target, binding, candidate, NULL), @"uncertain qualification cannot begin ownership");
  Check(!SSPreparationAcceptOwnership(source, target, binding, candidate, NULL), @"uncertain qualification cannot accept ownership");
  Check(!SSPreparationRecordFailure(source, target, binding, ECANCELED, NULL), @"uncertain qualification cannot record another failure");
  Check(!SSPreparationFinishFailure(source, target, binding, YES, ^BOOL { return NO; }, ^BOOL { launches++; return YES; }, NULL), @"uncertain qualification cannot finish or launch");
  Check(!SSPreparationRetire(source, target, NULL), @"uncertain qualification cannot retire");
  Check(!Save(NULL), @"uncertain qualification cannot save");
  Check(!Discard(SSPreparationRecord[@"source"], SSPreparationRecord[@"target"], NULL), @"uncertain qualification cannot discard");
  Check(!FailurePublished(), @"uncertain qualification cannot attest publication");
  Check(!SSPreparationOpenDirectory(store, NULL) && !SSPreparationOpenExistingDirectory(store, NULL), @"reopen cannot clear uncertainty in this process");
  Check(!SSPreparationCloseChecked(NULL) && fcntl(SSPreparationFD, F_GETFD) >= 0 && fcntl(SSPreparationLockFD, F_GETFD) >= 0, @"checked close retains primary descriptors");
  Check([Bytes(journal) isEqual:before] && [NSFileManager.defaultManager fileExistsAtPath:candidate.path] && launches == 0 && !SSReadinessFailedRequestBound(source, target, binding), @"all rejected followups preserve journal candidate notification and launch state");
  LockHeld(store);
  NSLog(@"[shipit-publication-fault] case=%lu checks=%lu PASS", (unsigned long)fault, (unsigned long)Passed);
}
int main(int argc, const char **argv) {
  fputs("[shipit-publication-fault] stage=main-enter\n", stderr); fflush(stderr);
  @autoreleasepool {
    assert(argc == 2 && geteuid() != 0);
    NSUInteger failures = 0;
    for (NSUInteger fault = PublicationChildClose; fault <= PublicationWriteClose; fault++) {
      NSString *root = [@(argv[1]) stringByAppendingPathComponent:[NSString stringWithFormat:@"case-%lu", (unsigned long)fault]];
      fprintf(stderr, "[shipit-publication-fault] stage=before-fork case=%lu\n", (unsigned long)fault); fflush(stderr);
      pid_t child = fork(); assert(child >= 0);
      if (child == 0) { Exercise(root, (PublicationFault)fault); _exit(0); }
      int status = 0; assert(waitpid(child, &status, 0) == child);
      NSLog(@"[shipit-publication-fault] child=%d case=%lu status=%d", child, (unsigned long)fault, status);
      if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) { failures++; continue; }
      NSString *store = [root stringByAppendingPathComponent:@"journal"];
      assert(SSPreparationOpenDirectory(store, NULL));
      NSString *candidateDirectory = SSPreparationRecord[@"directory"][@"path"];
      assert(SSPreparationCloseChecked(NULL));
      assert([NSFileManager.defaultManager removeItemAtPath:candidateDirectory error:NULL]);
    }
    assert(failures == 0);
    NSLog(@"[shipit-publication-fault] isolated fault cases passed=6");
    for (NSNumber *rebuild in @[@NO, @YES]) {
      for (NSNumber *fault in @[@(PublicationCandidateOpen), @(PublicationCandidateCapture), @(PublicationWriteClose),
                                @(PublicationFileSync), @(PublicationDirectorySync)]) {
        NSString *root = [@(argv[1]) stringByAppendingPathComponent:
          [NSString stringWithFormat:@"candidate-%@-%@", rebuild, fault]];
        pid_t child = fork(); assert(child >= 0);
        if (child == 0) { CheckCandidatePublication(root, rebuild.boolValue, fault.unsignedIntegerValue); _exit(0); }
        int status = 0; assert(waitpid(child, &status, 0) == child);
        NSLog(@"[shipit-publication-fault] candidate rebuild=%@ fault=%@ status=%d", rebuild, fault, status);
        if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) failures++;
      }
    }
    assert(failures == 0);
    NSLog(@"[shipit-publication-fault] initial and rebuild directory publication passed");
  }
  return 0;
}
