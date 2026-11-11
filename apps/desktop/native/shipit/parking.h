#import <ServiceManagement/ServiceManagement.h>
#import "succession.h"
#include <limits.h>

static const NSUInteger SSParkingArguments = 3;
static NSString * const SSParkingHelperPath = @"Contents/Frameworks/Squirrel.framework/Resources/ShipIt";

static inline NSString *SSParkingLabel(id bundle) {
  return [bundle isKindOfClass:NSString.class] && [bundle rangeOfString:SSSuccessionBundlePattern options:NSRegularExpressionSearch].location == 0
    ? [bundle stringByAppendingString:SSSuccessionHelperSuffix] : nil;
}

static inline NSDictionary *SSParkingJob(NSString *label, NSError **error) {
  NSArray *jobs = CFBridgingRelease(SMCopyAllJobDictionaries(kSMDomainUserLaunchd));
  if (![jobs isKindOfClass:NSArray.class]) { SSObservationFail(error, EIO); return nil; }
  NSDictionary *selected = @{};
  for (id job in jobs) {
    if (![job isKindOfClass:NSDictionary.class]) { SSObservationFail(error, EINVAL); return nil; }
    if ([job[@"Label"] isEqual:label]) {
      if (selected.count) { SSObservationFail(error, EEXIST); return nil; }
      selected = job;
    }
  }
  return selected;
}

static inline BOOL SSParkingMatches(NSDictionary *job, NSString *helper, NSString *label, NSString *state) {
  NSArray *arguments = job[@"ProgramArguments"];
  if (![job[@"Label"] isEqual:label] || ![arguments isKindOfClass:NSArray.class] || arguments.count != SSParkingArguments ||
      ![arguments[0] isKindOfClass:NSString.class] || ![arguments[1] isEqual:label] || ![arguments[2] isEqual:state] ||
      (job[@"Program"] && ![job[@"Program"] isEqual:arguments[0]])) return NO;
  char canonical[PATH_MAX];
  return realpath([arguments[0] fileSystemRepresentation], canonical) && [@(canonical) isEqual:helper];
}

static inline BOOL SSParkSuccession(NSDictionary *config, NSError **error) {
  NSString *label = nil;
  NSURL *state = [NSURL fileURLWithPath:config[@"state"]];
  int parent = SSObservationOpenDirectory(state.path.stringByDeletingLastPathComponent);
  if (parent < 0) return SSObservationFail(error, errno);
  NSDictionary *observed = SSObservationReadAt(parent, state.lastPathComponent, SSSuccessionStateBytes, NO, NO, error);
  int code = errno;
  if (close(parent) != 0) return SSObservationFail(error, errno);
  if (!observed) {
    if (code != ENOENT || !config[@"expected"]) return SSObservationFail(error, code);
    NSDictionary *expected = config[@"expected"];
    label = SSParkingLabel(expected[@"bundleIdentifier"]);
    if (!label) return SSObservationFail(error, EINVAL);
    NSDictionary *job = SSParkingJob(label, error);
    return job && !job.count ? YES : SSObservationFail(error, EBUSY);
  }
  NSMutableDictionary *request = [[NSJSONSerialization JSONObjectWithData:observed[@"data"] options:NSJSONReadingMutableContainers error:error] mutableCopy];
  if (![request isKindOfClass:NSDictionary.class] || ![request[@"binding"] isEqual:config[@"binding"]]) return SSObservationFail(error, ESTALE);
  for (NSArray *pair in @[@[@"updateBundleURL", @"source"], @[@"targetBundleURL", @"target"]]) {
    id value = request[pair[0]];
    NSURL *url = [value isKindOfClass:NSString.class] ? [NSURL URLWithString:value] : nil;
    if (!url.isFileURL || url.host.length || ![url.path isEqual:config[pair[1]]]) return SSObservationFail(error, ESTALE);
    request[pair[0]] = url;
  }
  label = SSParkingLabel(request[@"bundleIdentifier"]);
  if (!label) return SSObservationFail(error, EINVAL);
  NSDictionary *job = SSParkingJob(label, error);
  if (!job) return NO;
  if (!job.count) return YES;
  NSString *path = [config[@"target"] stringByAppendingPathComponent:SSParkingHelperPath];
  char canonical[PATH_MAX];
  if (!realpath(path.fileSystemRepresentation, canonical)) return SSObservationFail(error, errno);
  NSString *helper = @(canonical);
  if (![helper hasPrefix:[config[@"target"] stringByAppendingPathComponent:@"Contents/"]] ||
      !SSParkingMatches(job, helper, label, state.path) ||
      !SSVerifySuccession(request, state, label, SSSuccessionRollbackKey, error)) return SSObservationFail(error, EPERM);
  SSProcessExemption exemption = nil;
  id process = job[@"PID"];
  if (process && (!SSObservationInteger(process) || [process longLongValue] < 0 || [process longLongValue] > INT_MAX)) return SSObservationFail(error, EINVAL);
  if ([process intValue] > 0) {
    SSProcessIdentity identity;
    BOOL present = NO;
    if (!ObserveIdentity([process intValue], &identity, &present)) return SSObservationFail(error, errno);
    if (present) {
      if (identity.owner != getuid() || identity.real != getuid() || identity.saved != getuid()) return SSObservationFail(error, EBUSY);
      exemption = ^BOOL(SSProcessIdentity current, NSString *image) {
        char resolved[PATH_MAX];
        return EqualProcess(identity, current) && realpath(image.fileSystemRepresentation, resolved) && [@(resolved) isEqual:helper];
      };
    }
  }
  NSURL *source = request[@"updateBundleURL"], *target = request[@"targetBundleURL"];
  if (!SSPreparationOrphanSnapshot(source, target, config[@"binding"], state, config[@"expected"],
      ^SSPreparationActivity { return InspectActivityPolicy(source, target, exemption); }, error)) return NO;
  NSDictionary *fresh = SSParkingJob(label, error);
  if (!fresh || !SSParkingMatches(fresh, helper, label, state.path) ||
      !SSVerifySuccession(request, state, label, SSSuccessionRollbackKey, error)) return SSObservationFail(error, ESTALE);
  CFErrorRef failure = NULL;
  if (!SMJobRemove(kSMDomainUserLaunchd, (__bridge CFStringRef)label, NULL, true, &failure)) {
    if (error) *error = CFBridgingRelease(failure); else if (failure) CFRelease(failure);
    return NO;
  }
  NSDictionary *remaining = SSParkingJob(label, error);
  if (!remaining || remaining.count || !SSVerifySuccession(request, state, label, SSSuccessionRollbackKey, error)) return SSObservationFail(error, ESTALE);
  NSLog(@"[shipit-preparation] event=legacy-user-job-parked label=%@", label);
  return YES;
}
