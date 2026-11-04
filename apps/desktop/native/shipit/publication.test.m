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
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <mach/mach_time.h>

static int PublicationClose(int descriptor);
static int PublicationSync(int descriptor);
static ssize_t PublicationWrite(int descriptor, const void *bytes, size_t length);
#define close PublicationClose
#define fsync PublicationSync
#define write PublicationWrite
#import "preparation.m"
#undef close
#undef fsync
#undef write

typedef NS_ENUM(NSUInteger, PublicationFault) {
  PublicationChildClose,
  PublicationParentClose,
  PublicationFileClose,
  PublicationFileSync,
  PublicationDirectorySync,
  PublicationWriteClose,
};
static PublicationFault Fault;
static BOOL Armed, Fired, Counting;
static NSUInteger Matches, MatchToFail, Passed;
static NSDictionary *ClosingIdentity;
static BOOL WriteFailed, SuppressWriteClose;

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
  }
  return 0;
}
