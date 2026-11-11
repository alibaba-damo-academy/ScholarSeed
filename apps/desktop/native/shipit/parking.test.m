#define SS_PREFLIGHT_EMBED 1
#import "preflight.m"
#import <ServiceManagement/ServiceManagement.h>
static NSUInteger RemoveCalls;
static BOOL UseFixtureJobs;
static NSArray *FixtureJobs;
static CFArrayRef FixtureAllJobs(CFStringRef domain) {
  if (UseFixtureJobs) return CFBridgingRetain(FixtureJobs);
  return SMCopyAllJobDictionaries(domain);
}
static Boolean FixtureRemoveJob(CFStringRef domain, CFStringRef label, AuthorizationRef authorization, Boolean wait, CFErrorRef *error) {
  (void)domain; (void)label; (void)authorization; (void)wait; (void)error;
  RemoveCalls++;
  return false;
}
#define SMCopyAllJobDictionaries FixtureAllJobs
#define SMJobRemove FixtureRemoveJob
#import "parking.h"
#include <assert.h>

int main(int argc, const char **argv) {
  (void)InspectActivity;
  (void)InspectSelection;
  @autoreleasepool {
    assert(argc == 2);
    NSString *directory = @(argv[1]);
    assert([NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    NSString *helper = [directory stringByAppendingPathComponent:@"ShipIt"];
    assert([@"fixture" writeToFile:helper atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
    NSString *label = @"com.scholarseed.fixture.ShipIt", *state = [directory stringByAppendingPathComponent:@"state"];
    NSDictionary *job = @{@"Label":label, @"ProgramArguments":@[helper, label, state]};
    assert(SSParkingMatches(job, helper, label, state));
    assert(!SSParkingMatches(job, helper, @"other.job", state));
    assert(!SSParkingMatches(job, helper, label, [state stringByAppendingString:@".new"]));
    assert(!SSParkingMatches(@{@"Label":label, @"Program":@"/usr/bin/true", @"ProgramArguments":job[@"ProgramArguments"]}, helper, label, state));
    assert(!SSParkingMatches(@{@"Label":label, @"ProgramArguments":@[helper, label, state, @"extra"]}, helper, label, state));
    assert(!SSParkingMatches(@{@"Label":label, @"ProgramArguments":@[@1, label, state]}, helper, label, state));
    NSError *error = nil;
    NSDictionary *absent = SSParkingJob([@"com.scholarseed.fixture." stringByAppendingString:NSUUID.UUID.UUIDString], &error);
    assert(absent && !absent.count && !error);
    NSDictionary *config = @{@"state":state, @"source":directory, @"target":directory, @"binding":@{}};
    error = nil;
    assert(!SSParkSuccession(config, &error) && error.code == ENOENT && RemoveCalls == 0);
    assert([[NSJSONSerialization dataWithJSONObject:@[] options:0 error:NULL] writeToFile:state atomically:NO]);
    assert(chmod(state.fileSystemRepresentation, 0600) == 0);
    error = nil;
    assert(!SSParkSuccession(config, &error) && error.code == ESTALE && RemoveCalls == 0);
    NSString *source = [directory stringByAppendingPathComponent:@"source.app"], *target = [directory stringByAppendingPathComponent:@"target.app"];
    NSString *installedHelper = [target stringByAppendingPathComponent:SSParkingHelperPath];
    assert([NSFileManager.defaultManager createDirectoryAtPath:installedHelper.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    assert([@"fixture" writeToFile:installedHelper atomically:NO encoding:NSUTF8StringEncoding error:NULL]);
    NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],
      @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"candidate":@"fixture", @"size":@1};
    NSDictionary *request = @{@"bundleIdentifier":@"com.scholarseed.fixture", @"binding":binding,
      @"updateBundleURL":[NSURL fileURLWithPath:source].absoluteString, @"targetBundleURL":[NSURL fileURLWithPath:target].absoluteString,
      @"installationAuthorized":@NO, @"launchAfterInstallation":@NO, @"useUpdateBundleName":@YES};
    assert([[NSJSONSerialization dataWithJSONObject:request options:0 error:NULL] writeToFile:state atomically:NO]);
    config = @{@"state":state, @"source":source, @"target":target, @"binding":binding};
    UseFixtureJobs = YES;
    FixtureJobs = @[];
    assert(SSParkSuccession(config, NULL) && RemoveCalls == 0);
    FixtureJobs = @[@{@"Label":label, @"ProgramArguments":@[installedHelper, label, state]}];
    error = nil;
    assert(!SSParkSuccession(config, &error) && error.code == EPERM && RemoveCalls == 0);
    FixtureJobs = @[@{@"Label":label, @"Program":@"/usr/bin/true", @"ProgramArguments":@[installedHelper, label, state]}];
    error = nil;
    assert(!SSParkSuccession(config, &error) && error.code == EPERM && RemoveCalls == 0);
    NSLog(@"parking refusal checks passed=5; mutation calls=0; ServiceManagement removal is stubbed only in this contract");
    NSLog(@"parking ownership checks passed=7; user launchd query passed; no job mutated");
  }
  return 0;
}
