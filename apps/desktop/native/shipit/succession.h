#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import "binding.h"
#import "observation.h"
#include <errno.h>

static const NSUInteger SSSuccessionStateBytes = 64 * 1024;
static const NSUInteger SSSuccessionRequestFields = 7;
static const NSUInteger SSSuccessionStateArgument = 2;
static NSString * const SSSuccessionHelperSuffix = @".ShipIt";
static NSString * const SSSuccessionTeamPattern = @"^[A-Z0-9]{10}$";
static NSString * const SSSuccessionBundlePattern = @"^[A-Za-z0-9.-]+$";
static NSString * const SSSuccessionRollbackKey = @"SQRLInstallerOwnedBundle";

static inline NSURL *SSSuccessionStateURL(void) {
  NSArray *arguments = NSProcessInfo.processInfo.arguments;
  return arguments.count > SSSuccessionStateArgument ? [NSURL fileURLWithPath:arguments[SSSuccessionStateArgument]] : nil;
}
static inline NSDictionary *SSSuccessionRequest(NSDictionary *request) {
  NSMutableDictionary *serialized = [request mutableCopy];
  for (NSString *key in @[@"updateBundleURL", @"targetBundleURL"]) {
    NSURL *application = request[key];
    if (![application isKindOfClass:NSURL.class] || !application.isFileURL || application.host.length) return nil;
    serialized[key] = application.absoluteString;
  }
  return serialized;
}
static inline BOOL SSSuccessionSigned(NSURL *application, SecRequirementRef requirement, NSError **error) {
  SecStaticCodeRef code = NULL;
  OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)application, kSecCSDefaultFlags, &code);
  if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code,
    kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSNoNetworkAccess, requirement);
  if (code) CFRelease(code);
  if (status == errSecSuccess) return YES;
  if (error) *error = [NSError errorWithDomain:NSOSStatusErrorDomain code:status userInfo:nil];
  return NO;
}
static inline BOOL SSVerifySuccessionTrust(NSDictionary *request, NSString *label, NSString *rollbackKey, NSError **error) {
  NSString *bundle = request[@"bundleIdentifier"];
  NSDictionary *serialized = SSSuccessionRequest(request);
  if (request.count != SSSuccessionRequestFields || !SSBindingValid(request[@"binding"]) ||
      ![bundle isKindOfClass:NSString.class] || [bundle rangeOfString:SSSuccessionBundlePattern options:NSRegularExpressionSearch].location != 0 ||
      ![label isEqual:[bundle stringByAppendingString:SSSuccessionHelperSuffix]] ||
      !SSObservationBoolean(request[@"installationAuthorized"]) || [request[@"installationAuthorized"] boolValue] ||
      !SSObservationBoolean(request[@"launchAfterInstallation"]) || [request[@"launchAfterInstallation"] boolValue] ||
      !SSObservationBoolean(request[@"useUpdateBundleName"]) || !serialized || !rollbackKey.length)
    return SSObservationFail(error, EINVAL);
  CFPropertyListRef rollback = CFPreferencesCopyValue((__bridge CFStringRef)rollbackKey, (__bridge CFStringRef)label, kCFPreferencesCurrentUser, kCFPreferencesCurrentHost);
  if (rollback) { CFRelease(rollback); return SSObservationFail(error, EBUSY); }
  SecCodeRef running = NULL;
  CFDictionaryRef information = NULL;
  OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &running);
  if (status == errSecSuccess) status = SecCodeCopySigningInformation(running, kSecCSSigningInformation, &information);
  NSString *team = information ? ((__bridge NSDictionary *)information)[(__bridge NSString *)kSecCodeInfoTeamIdentifier] : nil;
  if (running) CFRelease(running);
  SecRequirementRef requirement = NULL;
  if (status == errSecSuccess && [team isKindOfClass:NSString.class] &&
      [team rangeOfString:SSSuccessionTeamPattern options:NSRegularExpressionSearch].location == 0) {
    NSString *text = [NSString stringWithFormat:@"anchor apple generic and certificate leaf[subject.OU] = \"%@\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier \"%@\"", team, bundle];
    status = SecRequirementCreateWithString((__bridge CFStringRef)text, kSecCSDefaultFlags, &requirement);
  } else status = errSecCSUnsigned;
  if (information) CFRelease(information);
  BOOL verified = status == errSecSuccess;
  for (NSString *key in @[@"updateBundleURL", @"targetBundleURL"]) {
    if (!verified) break;
    verified = SSSuccessionSigned(request[key], requirement, error);
  }
  if (requirement) CFRelease(requirement);
  return verified ? YES : SSObservationFail(error, EPERM);
}
static inline BOOL SSVerifySuccession(NSDictionary *request, NSURL *state, NSString *label, NSString *rollbackKey, NSError **error) {
  if (!state.isFileURL || state.host.length) return SSObservationFail(error, EINVAL);
  int directory = SSObservationOpenDirectory(state.path.stringByDeletingLastPathComponent);
  if (directory < 0) return SSObservationFail(error, errno);
  NSDictionary *before = SSObservationReadAt(directory, state.lastPathComponent, SSSuccessionStateBytes, NO, NO, error);
  NSDictionary *current = before ? [NSJSONSerialization JSONObjectWithData:before[@"data"] options:0 error:NULL] : nil;
  BOOL verified = [current isEqual:SSSuccessionRequest(request)] && SSVerifySuccessionTrust(request, label, rollbackKey, error);
  NSDictionary *after = verified ? SSObservationReadAt(directory, state.lastPathComponent, SSSuccessionStateBytes, NO, NO, error) : nil;
  if (close(directory) != 0) return SSObservationFail(error, errno);
  if (!verified || ![before[@"snapshot"] isEqual:after[@"snapshot"]]) return SSObservationFail(error, EPERM);
  return YES;
}
