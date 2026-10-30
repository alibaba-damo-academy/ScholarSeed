#import "binding.h"
#import "preparation.h"
#import "readiness.h"
#import "SQRLShipItRequest.h"
#import <ReactiveObjC/ReactiveObjC.h>
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
    NSData *bytes = [@"exact native download" dataUsingEncoding:NSUTF8StringEncoding];
    unsigned char hash[CC_SHA512_DIGEST_LENGTH]; CC_SHA512(bytes.bytes, (CC_LONG)bytes.length, hash);
    NSMutableString *hex = [NSMutableString string];
    for (NSUInteger index = 0; index < CC_SHA512_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", hash[index]];
    NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0], @"candidate":@"candidate-a", @"sha512":hex, @"size":@(bytes.length)};
    assert(SSBindingVerify(binding, bytes));
    assert(!SSBindingVerify(binding, [@"other native content" dataUsingEncoding:NSUTF8StringEncoding]));
    assert(!SSBindingVerify(binding, [bytes subdataWithRange:NSMakeRange(0, bytes.length - 1)]));
    NSMutableDictionary *other = [binding mutableCopy]; other[@"candidate"] = @"candidate-b";
    assert(SSBindingVerify(other, bytes) && ![binding isEqual:other]);
    other[@"requestId"] = @[@"not-a-string"]; assert(!SSBindingValid(other));
    NSURL *source = Bundle([root stringByAppendingPathComponent:@"request/New.app"]);
    NSURL *target = Bundle([root stringByAppendingPathComponent:@"live/Old.app"]);
    SQRLShipItRequest *request = [[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target bundleIdentifier:@"fixture.none" launchAfterInstallation:NO useUpdateBundleName:YES binding:binding installationAuthorized:NO];
    NSURL *state = [NSURL fileURLWithPath:[root stringByAppendingPathComponent:@"state.json"]];
    NSError *error = nil;
    assert([[request writeUsingURL:[RACSignal return:state]] waitUntilCompleted:&error] && !error);
    SQRLShipItRequest *read = [[SQRLShipItRequest readUsingURL:[RACSignal return:state]] firstOrDefault:nil success:NULL error:&error];
    assert(read && [read.binding isEqual:binding] && !read.installationAuthorized);
    NSMutableDictionary *original = [request.dictionaryValue mutableCopy];
    NSMutableDictionary *granted = [original mutableCopy]; granted[@"installationAuthorized"] = @YES; granted[@"launchAfterInstallation"] = @YES;
    assert(SSBindingRequestMatches(original, granted));
    for (NSString *key in @[@"updateBundleURL", @"targetBundleURL", @"bundleIdentifier", @"useUpdateBundleName", @"binding", @"launchAfterInstallation"]) {
      NSMutableDictionary *changed = [granted mutableCopy]; changed[key] = [key isEqual:@"useUpdateBundleName"] || [key isEqual:@"launchAfterInstallation"] ? @NO : NSNull.null;
      assert(!SSBindingRequestMatches(original, changed));
    }
    NSMutableDictionary *json = [[NSJSONSerialization JSONObjectWithData:[NSData dataWithContentsOfURL:state] options:NSJSONReadingMutableContainers error:NULL] mutableCopy];
    json[@"installationAuthorized"] = @1;
    assert([[NSJSONSerialization dataWithJSONObject:json options:0 error:NULL] writeToURL:state atomically:YES]);
    error = nil; assert(![[SQRLShipItRequest readUsingURL:[RACSignal return:state]] firstOrDefault:nil success:NULL error:&error] && error);
    assert([[@"[]" dataUsingEncoding:NSUTF8StringEncoding] writeToURL:state atomically:YES]);
    error = nil; assert(![[SQRLShipItRequest readUsingURL:[RACSignal return:state]] firstOrDefault:nil success:NULL error:&error] && error);
    NSString *store = [root stringByAppendingPathComponent:@"journal"];
    assert([NSFileManager.defaultManager createDirectoryAtPath:store withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
    assert(SSPreparationOpenDirectory(store, NULL));
    NSURL *candidate = SSPreparationCopy(source, target, binding, NULL); assert(candidate);
    other = [binding mutableCopy]; other[@"candidate"] = @"candidate-b";
    assert(!SSPreparationCopy(source, target, other, NULL));
    assert(!SSPreparationValidate(source, target, other, candidate, NULL));
    assert(SSPreparationValidate(source, target, binding, candidate, NULL));
    assert(SSReadinessPublishBound(source, target, binding, YES, 0, NULL));
    assert(SSReadinessReadBound(source, target, binding, NULL) == SSReadinessReady);
    error = nil; assert(SSReadinessReadBound(source, target, other, &error) == SSReadinessFailed && error);
    assert(!SSReadinessFailedRequestBound(source, target, other));
    assert(SSPreparationRecordFailure(source, target, binding, ECANCELED, NULL));
    assert(SSReadinessReadBound(source, target, binding, NULL) == SSReadinessReady);
    SQRLShipItRequest *late = [[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target bundleIdentifier:@"fixture.none" launchAfterInstallation:YES useUpdateBundleName:YES binding:binding installationAuthorized:YES];
    assert([[late writeUsingURL:[RACSignal return:state]] waitUntilCompleted:NULL]);
    late = [[SQRLShipItRequest readUsingURL:[RACSignal return:state]] firstOrDefault:nil];
    assert(late.installationAuthorized && !SSPreparationValidate(source, target, late.binding, candidate, NULL));
    SSPreparationClose(); assert(SSPreparationOpenDirectory(store, NULL));
    NSInteger code = 0;
    assert(SSPreparationRecoverFailure(source, target, other, &code, NULL) == SSPreparationFailureInvalid);
    assert(SSPreparationRecoverFailure(source, target, binding, &code, NULL) == SSPreparationFailureRestored && code == ECANCELED);
    assert(SSReadinessPublishBound(source, target, binding, NO, code, NULL));
    assert(SSReadinessFailedRequestBound(source, target, binding));
    assert(!SSPreparationCopy(source, target, binding, NULL));
    assert(!SSPreparationValidate(source, target, binding, candidate, NULL));
    SSPreparationClose();
    assert([NSFileManager.defaultManager removeItemAtPath:candidate.path.stringByDeletingLastPathComponent error:NULL]);
    NSLog(@"[shipit-binding-test] actual bytes, request, immutable fields, private fence and bound acknowledgement PASS");
  }
  return 0;
}
