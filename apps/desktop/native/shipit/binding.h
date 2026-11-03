#import <Foundation/Foundation.h>
#import <CommonCrypto/CommonDigest.h>

static inline BOOL SSBindingHex(id value, NSUInteger length) {
  return [value isKindOfClass:NSString.class] && [value length] == length &&
    [value rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet]].location == NSNotFound;
}
static inline BOOL SSBindingValid(id value) {
  if (![value isKindOfClass:NSDictionary.class] || [value count] != 5) return NO;
  id schema = value[@"schema"], size = value[@"size"], candidate = value[@"candidate"];
  return [schema isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)schema) != CFBooleanGetTypeID() && [schema isEqual:@1] &&
    [size isKindOfClass:NSNumber.class] && CFGetTypeID((__bridge CFTypeRef)size) != CFBooleanGetTypeID() &&
    [size doubleValue] == [size unsignedLongLongValue] && [size unsignedLongLongValue] > 0 && [size unsignedLongLongValue] < 1024ULL * 1024 * 1024 &&
    [candidate isKindOfClass:NSString.class] && [candidate length] > 0 && [candidate length] <= 512 &&
    SSBindingHex(value[@"requestId"], 64) && SSBindingHex(value[@"sha512"], 128);
}
static inline NSDictionary *SSBindingFromName(NSString *name) {
  if (![name isKindOfClass:NSString.class] || name.length > 4096) return nil;
  id binding = [NSJSONSerialization JSONObjectWithData:[name dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
  return SSBindingValid(binding) ? binding : nil;
}
static inline BOOL SSBindingVerify(NSDictionary *binding, NSData *data) {
  if (!SSBindingValid(binding) || data.length != [binding[@"size"] unsignedLongLongValue]) return NO;
  unsigned char digest[CC_SHA512_DIGEST_LENGTH];
  CC_SHA512(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA512_DIGEST_LENGTH * 2];
  for (NSUInteger index = 0; index < CC_SHA512_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
  return [hex isEqual:binding[@"sha512"]];
}
static inline BOOL SSBindingRequestMatches(NSDictionary *prepared, NSDictionary *current) {
  if (!SSBindingValid(prepared[@"binding"]) || ![prepared[@"binding"] isEqual:current[@"binding"]]) return NO;
  for (NSString *key in @[@"updateBundleURL", @"targetBundleURL", @"bundleIdentifier", @"useUpdateBundleName"])
    if (![(prepared[key] ?: NSNull.null) isEqual:(current[key] ?: NSNull.null)]) return NO;
  return ![current[@"installationAuthorized"] boolValue] || [current[@"launchAfterInstallation"] boolValue];
}
