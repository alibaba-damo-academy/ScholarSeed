#import "preparation.h"
#import "cleanup.h"
#import "observation.h"
#include <assert.h>
#include <sys/stat.h>
#include <unistd.h>

static CFPropertyListRef FixtureRollback;
static CFPropertyListRef FixtureCopyPreference(CFStringRef key, CFStringRef application, CFStringRef user, CFStringRef host) {
  (void)key; (void)application; (void)user; (void)host;
  return FixtureRollback ? CFRetain(FixtureRollback) : NULL;
}
#define CFPreferencesCopyValue FixtureCopyPreference
#import "succession.h"
#undef CFPreferencesCopyValue

static NSFileManager *Manager;
static NSUInteger Passed;
static NSString *Root;

static NSString *Directory(NSString *path) {
  assert([Manager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
  return path;
}
static NSURL *Bundle(NSString *path) {
  Directory([path stringByAppendingPathComponent:@"Contents"]);
  return [NSURL fileURLWithPath:path];
}
static NSDictionary *Binding(NSString *character) {
  return @{@"schema":@1, @"requestId":[character stringByPaddingToLength:64 withString:character startingAtIndex:0],
    @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@1, @"candidate":character};
}
static NSData *Bytes(NSString *store) {
  NSData *data = [NSData dataWithContentsOfFile:[store stringByAppendingPathComponent:@"journal.plist"]];
  assert(data); return data;
}
static void Write(NSString *store, NSDictionary *journal) {
  NSString *path = [store stringByAppendingPathComponent:@"journal.plist"];
  assert([[NSPropertyListSerialization dataWithPropertyList:journal format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL] writeToFile:path atomically:YES]);
  assert(chmod(path.fileSystemRepresentation, 0600) == 0);
}
static void Check(BOOL value, NSString *label) {
  if (!value) NSLog(@"FAIL %@", label);
  assert(value); Passed++;
}
static void TrustRefusals(void) {
  NSString *label = @"com.scholarseed.fixture.ShipIt";
  NSDictionary *request = @{@"bundleIdentifier":@"com.scholarseed.fixture", @"binding":Binding(@"a"),
    @"updateBundleURL":[NSURL fileURLWithPath:@"/fixture/source.app"], @"targetBundleURL":[NSURL fileURLWithPath:@"/fixture/target.app"],
    @"installationAuthorized":@NO, @"launchAfterInstallation":@NO, @"useUpdateBundleName":@YES};
  NSError *error = nil;
  NSMutableDictionary *invalid = [request mutableCopy]; invalid[@"bundleIdentifier"] = @"invalid\"bundle";
  Check(!SSVerifySuccessionTrust(invalid, label, SSSuccessionRollbackKey, &error) && error.code == EINVAL, @"succession rejects invalid bundle syntax before signature construction");
  error = nil;
  Check(!SSVerifySuccessionTrust(request, @"other.ShipIt", SSSuccessionRollbackKey, &error) && error.code == EINVAL, @"succession requires exact bundle and helper label binding");
  FixtureRollback = kCFBooleanTrue;
  error = nil;
  Check(!SSVerifySuccessionTrust(request, label, SSSuccessionRollbackKey, &error) && error.code == EBUSY, @"succession refuses an existing rollback before trust admission");
  FixtureRollback = NULL;
  error = nil;
  Check(!SSVerifySuccessionTrust(request, label, SSSuccessionRollbackKey, &error) && error.code == EPERM, @"ad-hoc test host cannot authorize Developer ID succession");
  error = nil;
  Check(!SSSuccessionSigned(request[@"updateBundleURL"], NULL, &error) && error, @"missing signed candidate is not trusted");
  error = nil;
  Check(!SSVerifySuccession(request, [NSURL URLWithString:@"https://invalid/state"], label, SSSuccessionRollbackKey, &error) && error.code == EINVAL, @"succession requires a local state URL");
}
int main(int argc, const char **argv) {
  @autoreleasepool {
    assert(argc == 2 && geteuid() != 0);
    Manager = NSFileManager.defaultManager;
    Root = Directory(@(argv[1])).stringByResolvingSymlinksInPath;
    TrustRefusals();
    for (NSString *name in @[@"machine", @"repair-resume", @"source-live", @"candidate-live", @"source-link", @"candidate-link", @"signature", @"target-race", @"journal-race", @"ownership", @"archive-link", @"archive-corrupt", @"save", @"same-binding", @"different-target", @"new-protocol", @"partial-archive"]) {
      NSString *fixture = Directory([Root stringByAppendingPathComponent:name]);
      NSString *store = Directory([fixture stringByAppendingPathComponent:@"preparation"]);
      NSString *cleanup = Directory([fixture stringByAppendingPathComponent:@"cleanup"]);
      NSURL *source = Bundle([fixture stringByAppendingPathComponent:@"cache/update.old/ScholarSeed.app"]);
      NSURL *target = Bundle([fixture stringByAppendingPathComponent:@"installed/ScholarSeed.app"]);
      NSURL *next = Bundle([fixture stringByAppendingPathComponent:@"cache/update.new/ScholarSeed.app"]);
      NSDictionary *binding = Binding(@"a"), *nextBinding = Binding(@"c");
      assert(SSCleanupOpenDirectory(cleanup, NULL));
      assert(SSPreparationOpenDirectory(store, NULL));
      NSURL *candidate = SSPreparationCopy(source, target, binding, NULL); assert(candidate);
      assert(SSPreparationRecordFailure(source, target, binding, ETIMEDOUT, NULL));
      SSPreparationClose();
      NSMutableDictionary *journal = [NSPropertyListSerialization propertyListWithData:Bytes(store) options:NSPropertyListMutableContainers format:NULL error:NULL];
      if (![name isEqual:@"new-protocol"]) [journal[@"record"] removeObjectForKey:@"terminalVersion"];
      if ([name isEqual:@"ownership"]) journal[@"record"][@"ownership"] = @YES;
      Write(store, journal);
      NSString *oldDirectory = candidate.path.stringByDeletingLastPathComponent;
      if (![name isEqual:@"candidate-live"]) assert([Manager removeItemAtPath:oldDirectory error:NULL]);
      if (![name isEqual:@"source-live"]) assert([Manager removeItemAtPath:source.path.stringByDeletingLastPathComponent error:NULL]);
      if ([name isEqual:@"source-link"]) assert(symlink(next.path.stringByDeletingLastPathComponent.fileSystemRepresentation, source.path.stringByDeletingLastPathComponent.fileSystemRepresentation) == 0);
      if ([name isEqual:@"candidate-link"]) assert(symlink(next.path.stringByDeletingLastPathComponent.fileSystemRepresentation, oldDirectory.fileSystemRepresentation) == 0);
      assert([Manager moveItemAtPath:target.path toPath:[target.path stringByAppendingString:@".previous"] error:NULL]);
      Bundle(target.path);
      NSData *before = Bytes(store);
      NSString *archive = [store stringByAppendingPathComponent:[NSString stringWithFormat:@"superseded-%@.plist", SSObservationDigest(before)]];
      if ([name isEqual:@"archive-link"]) assert(symlink([store stringByAppendingPathComponent:@"journal.plist"].fileSystemRepresentation, archive.fileSystemRepresentation) == 0);
      if ([name isEqual:@"archive-corrupt"]) { assert([@"corrupt" writeToFile:archive atomically:YES encoding:NSUTF8StringEncoding error:NULL]); assert(chmod(archive.fileSystemRepresentation, 0600) == 0); }
      if ([name isEqual:@"partial-archive"]) { assert([@"partial" writeToFile:[archive stringByAppendingString:@".next"] atomically:YES encoding:NSUTF8StringEncoding error:NULL]); assert(chmod([archive stringByAppendingString:@".next"].fileSystemRepresentation, 0600) == 0); }
      if ([name isEqual:@"save"]) Directory([store stringByAppendingPathComponent:@"journal.next"]);
      if ([name isEqual:@"same-binding"]) nextBinding = binding;
      if ([name isEqual:@"different-target"]) target = Bundle([fixture stringByAppendingPathComponent:@"other/ScholarSeed.app"]);
      assert(SSPreparationOpenDirectory(store, NULL));
      Check(SSPreparationRecoverFailure(next, target, nextBinding, NULL, NULL) == SSPreparationFailureInvalid, @"normal admission does not guess an orphan outcome");
      NSUInteger __block verifications = 0;
      BOOL (^verify)(NSError **) = ^BOOL(NSError **error) {
        (void)error; verifications++;
        if ([name isEqual:@"target-race"]) {
          assert([Manager moveItemAtPath:target.path toPath:[target.path stringByAppendingString:@".raced"] error:NULL]);
          Bundle(target.path);
        }
        if ([name isEqual:@"journal-race"]) Write(store, journal);
        return ![name isEqual:@"signature"];
      };
      BOOL recovered;
      BOOL nativeRepair = [@[@"machine", @"repair-resume"] containsObject:name];
      if (nativeRepair) {
        NSURL *state = [NSURL fileURLWithPath:[fixture stringByAppendingPathComponent:@"ShipItState.plist"]];
        NSData *stateBytes = [NSJSONSerialization dataWithJSONObject:@{@"binding":nextBinding, @"bundleIdentifier":@"com.scholarseed.desktop",
          @"updateBundleURL":next.absoluteString, @"targetBundleURL":target.absoluteString,
          @"installationAuthorized":@NO, @"launchAfterInstallation":@NO, @"useUpdateBundleName":@YES} options:0 error:NULL];
        assert([stateBytes writeToURL:state atomically:YES]); assert(chmod(state.path.fileSystemRepresentation, 0600) == 0);
        SSPreparationActivity (^idle)(void) = ^SSPreparationActivity {return SSPreparationActivityAbsent;};
        if ([name isEqual:@"machine"]) {
          for (id malformed in @[@[], @[@"first", @"second"], @"invalid", @42, @{@"schema":@"1", @"record":@[]}, @{@"schema":@"1", @"record":@42}]) {
            NSData *invalid = [NSPropertyListSerialization dataWithPropertyList:malformed format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL];
            NSString *journalPath = [store stringByAppendingPathComponent:@"journal.plist"];
            assert([invalid writeToFile:journalPath atomically:YES]); assert(chmod(journalPath.fileSystemRepresentation, 0600) == 0);
            NSError *error = nil;
            Check(!SSPreparationReconcile(next, target, nextBinding, verify, &error) && error.code == ESTALE, @"malformed reread journal refuses reconciliation without throwing");
            error = nil;
            Check(!SSPreparationOrphanSnapshot(next, target, nextBinding, state, nil, idle, &error) && error.code == ESTALE, @"malformed current journal refuses orphan qualification without throwing");
            Check(verifications == 0 && [Bytes(store) isEqual:invalid], @"malformed journals neither enter verification nor mutate evidence");
            assert([before writeToFile:journalPath atomically:YES]); assert(chmod(journalPath.fileSystemRepresentation, 0600) == 0);
          }
        }
        NSDictionary *proof = SSPreparationOrphanSnapshot(next, target, nextBinding, state, nil, idle, NULL); assert(proof);
        if ([name isEqual:@"machine"]) {
          for (id malformed in @[@[], @[@"first", @"second"], @"invalid", @42, @{@"schema":@"1", @"record":@[]}, @{@"schema":@"1", @"record":@42}]) {
            NSMutableDictionary *invalidProof = [proof mutableCopy];
            invalidProof[@"journalBytes"] = [[NSPropertyListSerialization dataWithPropertyList:malformed format:NSPropertyListBinaryFormat_v1_0 options:0 error:NULL] base64EncodedStringWithOptions:0];
            NSError *error = nil;
            NSInteger expectedCode = [malformed isKindOfClass:NSDictionary.class] ? EINVAL : ESTALE;
            Check(!SSPreparationOrphanSnapshot(next, target, nextBinding, state, invalidProof, idle, &error) && error.code == expectedCode, @"malformed archived proof refuses without throwing");
            Check([Bytes(store) isEqual:before], @"invalid archived proof leaves native journal unchanged");
          }
        }
        if ([name isEqual:@"repair-resume"]) {
          assert(SSPreparationReconcile(next, target, nextBinding, verify, NULL));
          SSPreparationClose(); assert(SSPreparationOpenMaintenanceDirectory(store, NULL));
          Check(SSPreparationOrphanSnapshot(next, target, nextBinding, state, proof, idle, NULL) != nil, @"interrupted native retirement reopens only with its exact archived proof");
        }
        recovered = SSPreparationRepair(next, target, nextBinding, state, proof, idle, verify, NULL);
        Check(![Manager fileExistsAtPath:state.path], @"native repair consumes the exact unauthorized pending request");
        Check(SSPreparationOrphanSnapshot(next, target, nextBinding, state, proof, idle, NULL) != nil, @"native proof survives complete retirement for Desktop WAL continuation");
      } else recovered = SSPreparationReconcile(next, target, nextBinding, verify, NULL);
      BOOL success = [@[@"machine", @"repair-resume", @"partial-archive"] containsObject:name];
      Check(recovered == success, [name stringByAppendingString:@" reconciliation result"]);
      if (success) {
        Check(verifications == ([name isEqual:@"repair-resume"] ? 2u : 1u), @"fresh request trust is verified before retirement");
        Check([[NSData dataWithContentsOfFile:archive] isEqual:before], @"retirement retains the exact legacy journal bytes");
        Check(SSPreparationRecoverFailure(next, target, nextBinding, NULL, NULL) == SSPreparationFailureNone, @"retirement does not grant installation or replay the old failure");
        SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
        NSURL *prepared = SSPreparationCopy(next, target, nextBinding, NULL);
        Check(prepared != nil && SSPreparationValidate(next, target, nextBinding, prepared, NULL), @"reopening continues through normal candidate preparation and validation");
        Check(!SSPreparationValidate(next, target, binding, prepared, NULL), @"old request cannot use the new prepared candidate");
        Check([Manager fileExistsAtPath:next.path] && [Manager fileExistsAtPath:target.path], @"recovery preserves current application and selected update");
        assert([Manager removeItemAtPath:prepared.path.stringByDeletingLastPathComponent error:NULL]);
      } else {
        Check([Bytes(store) isEqual:before], @"refused or failed recovery preserves the original journal");
      }
      SSPreparationClose(); SSCleanupClose();
      if ([Manager fileExistsAtPath:oldDirectory] && ![name isEqual:@"candidate-link"]) assert([Manager removeItemAtPath:oldDirectory error:NULL]);
      NSLog(@"[shipit-succession-test] %@ PASS", name);
    }
    NSLog(@"[shipit-succession-test] passed=%lu", (unsigned long)Passed);
  }
  return 0;
}
