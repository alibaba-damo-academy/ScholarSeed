#import "cleanup.h"
#import "preparation.h"
#include <assert.h>
#include <stdio.h>

static NSString *Directory(NSString *path) {
  assert([NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:@{NSFilePosixPermissions:@0700} error:NULL]);
  return path;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    assert(argc == 2);
    NSString *root = Directory(@(argv[1]));
    NSString *cleanup = Directory([root stringByAppendingPathComponent:@"cleanup"]);
    NSString *preparation = Directory([root stringByAppendingPathComponent:@"preparation"]);
    NSString *sourcePath = [root stringByAppendingPathComponent:@"download/source.app"];
    NSString *targetPath = [root stringByAppendingPathComponent:@"target.app"];
    Directory([sourcePath stringByAppendingPathComponent:@"Contents"]);
    Directory([targetPath stringByAppendingPathComponent:@"Contents/Resources"]);
    NSURL *source = [NSURL fileURLWithPath:sourcePath], *target = [NSURL fileURLWithPath:targetPath];
    NSDictionary *binding = @{@"schema":@1, @"requestId":[@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0], @"candidate":@"fixture-candidate", @"sha512":[@"b" stringByPaddingToLength:128 withString:@"b" startingAtIndex:0], @"size":@100};
    assert(SSCleanupOpenDirectory(cleanup, NULL));
    assert(SSPreparationOpenDirectory(preparation, NULL));
    assert(SSPreparationCopy(source, target, binding, NULL));
    assert(SSPreparationRecordFailure(source, target, binding, 60, NULL));
    assert(SSPreparationFinishFailure(source, target, binding, NO, nil, nil, NULL));
    assert(SSPreparationCloseChecked(NULL));
    assert(SSCleanupCloseChecked(NULL));
    NSString *state = [root stringByAppendingPathComponent:@"request.json"];
    NSDictionary *request = @{@"binding":binding, @"updateBundleURL":source.absoluteString, @"targetBundleURL":target.absoluteString, @"bundleIdentifier":@"com.scholarseed.desktop", @"useUpdateBundleName":@YES, @"installationAuthorized":@NO, @"launchAfterInstallation":@YES};
    NSData *bytes = [NSJSONSerialization dataWithJSONObject:request options:NSJSONWritingSortedKeys error:NULL];
    assert([NSFileManager.defaultManager createFileAtPath:state contents:bytes attributes:@{NSFilePosixPermissions:@0600}]);
    NSDictionary *result = @{@"source":source.path, @"application":target.path, @"cleanup":cleanup, @"preparation":preparation, @"nativeState":state, @"binding":binding};
    bytes = [NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingSortedKeys error:NULL];
    assert(fwrite(bytes.bytes, 1, bytes.length, stdout) == bytes.length);
    assert(fputc('\n', stdout) != EOF);
  }
  return 0;
}
