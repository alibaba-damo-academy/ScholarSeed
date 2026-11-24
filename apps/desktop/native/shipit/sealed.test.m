#import <Foundation/Foundation.h>
#import <preparation.h>
#include <assert.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

// Run the patched installer with an isolated journal and signed fixture applications.
static NSString *preparationStore;
#define SSPreparationOpen(label, error) SSPreparationOpenDirectory(preparationStore, error)
#define main originalShipItMain
#include "ShipIt-main.m"
#undef main

// cfprefsd persists even a test domain outside TMPDIR. Keep the same keys and
// durable values in the scenario directory across independent helper processes.
static NSString *preferencesPath;
static NSMutableDictionary *preferences;
CFPropertyListRef SSFixtureCopyValue(CFStringRef key, CFStringRef domain, CFStringRef user, CFStringRef host) {
    return CFBridgingRetain(preferences[(__bridge NSString *)key]);
}
void SSFixtureSetValue(CFStringRef key, CFPropertyListRef value, CFStringRef domain, CFStringRef user, CFStringRef host) {
    if (value) preferences[(__bridge NSString *)key] = (__bridge id)value;
    else [preferences removeObjectForKey:(__bridge NSString *)key];
}
Boolean SSFixtureSynchronize(CFStringRef domain, CFStringRef user, CFStringRef host) {
    return [preferences writeToFile:preferencesPath atomically:YES];
}
CFIndex SSFixtureGetAppIntegerValue(CFStringRef key, CFStringRef domain, Boolean *valid) {
    NSNumber *number = preferences[(__bridge NSString *)key];
    if (valid) *valid = [number isKindOfClass:NSNumber.class];
    return number.integerValue;
}

static int recordLaunch(NSBundle *bundle) {
    NSString *root = bundle.bundlePath.stringByDeletingLastPathComponent;
    struct stat target;
    assert(lstat(bundle.bundlePath.fileSystemRepresentation, &target) == 0);
    NSDictionary *observation = @{@"pid":@(getpid()), @"inode":@(target.st_ino),
        @"version":[bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"], @"application":bundle.bundlePath};
    NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:observation options:0 error:NULL] mutableCopy];
    assert(line);
    [line appendBytes:"\n" length:1];
    int fd = open([root stringByAppendingPathComponent:@"launches.jsonl"].fileSystemRepresentation,
                  O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW, 0600);
    assert(fd >= 0 && write(fd, line.bytes, line.length) == (ssize_t)line.length && close(fd) == 0);
    return EXIT_SUCCESS;
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if ([NSBundle.mainBundle.bundleIdentifier isEqual:@"org.scholarseed.test.sealed"] &&
        [NSProcessInfo.processInfo.arguments.firstObject.lastPathComponent isEqual:@"Fixture"])
        return recordLaunch(NSBundle.mainBundle);
    assert(argc == 3 && geteuid() != 0);
    NSString *mode = @(argv[1]), *path = @(argv[2]);
    if ([mode isEqual:launchSignal]) {
      // The production launch request receives the installed app URL and exits
      // after NSWorkspace opens it. Only installer requests use the fixture journal.
      if ([NSProcessInfo.processInfo.environment[@"SHIPIT_TEST_WORKSPACE"] isEqual:@"1"])
        return originalShipItMain(argc, argv);
      // Headless builds still execute the actual installed application's binary.
      NSString *executable = [path stringByAppendingPathComponent:@"Contents/MacOS/Fixture"];
      execl(executable.fileSystemRepresentation, executable.fileSystemRepresentation, NULL);
      return EXIT_FAILURE;
    }
    BOOL replay = [mode isEqual:@"replay"];
    assert(([@[@"rebuild", @"damaged-source", @"mixed", @"added", @"altered", @"cancel", @"replay"] containsObject:mode]));
    preferencesPath = [path stringByAppendingPathComponent:@"preferences.plist"];
    if ([NSFileManager.defaultManager fileExistsAtPath:preferencesPath]) {
        preferences = [NSMutableDictionary dictionaryWithContentsOfFile:preferencesPath];
        assert(preferences);
    } else {
        preferences = [NSMutableDictionary dictionary];
    }
    NSURL *source = [NSURL fileURLWithPath:[path stringByAppendingPathComponent:@"download/Fixture.app"] isDirectory:YES];
    NSURL *target = [NSURL fileURLWithPath:[path stringByAppendingPathComponent:@"Fixture.app"] isDirectory:YES];
    preparationStore = [path stringByAppendingPathComponent:@"CandidatePreparation"];
    assert(SSCleanupOpenDirectory([path stringByAppendingPathComponent:@"DeferredCleanup"], NULL));
    NSDictionary *binding = @{@"schema":@1, @"requestId":[@"e" stringByPaddingToLength:64 withString:@"e" startingAtIndex:0],
        @"candidate":@"sealed", @"sha512":[@"f" stringByPaddingToLength:128 withString:@"f" startingAtIndex:0], @"size":@100};
    __block NSUInteger reads = 0;
    RACSignal *requests = [RACSignal defer:^{
        BOOL first = reads++ == 0;
        if (!replay && !first) {
            assert(reads == 2 && SSReadinessRead(source, target, NULL) == SSReadinessReady);
            NSURL *candidate = SSPreparationCopy(source, target, binding, NULL);
            assert(candidate && SSPreparationValidate(source, target, binding, candidate, NULL));
            NSString *member = @"Contents/Resources/sealed.txt";
            if (![mode isEqual:@"altered"])
                assert(unlink([candidate URLByAppendingPathComponent:member].fileSystemRepresentation) == 0);
            if ([mode isEqual:@"damaged-source"])
                assert(unlink([source URLByAppendingPathComponent:member].fileSystemRepresentation) == 0);
            if ([mode isEqual:@"mixed"] || [mode isEqual:@"altered"])
                assert([@"altered" writeToURL:[candidate URLByAppendingPathComponent:@"Contents/Resources/other.txt"]
                    atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
            if ([mode isEqual:@"added"])
                assert([@"added" writeToURL:[candidate URLByAppendingPathComponent:@"Contents/Resources/additional.txt"]
                    atomically:YES encoding:NSUTF8StringEncoding error:NULL]);
        }
        BOOL authorized = replay || (!first && ![mode isEqual:@"cancel"]);
        return [RACSignal return:[[SQRLShipItRequest alloc] initWithUpdateBundleURL:source targetBundleURL:target
            bundleIdentifier:nil launchAfterInstallation:authorized useUpdateBundleName:NO binding:binding installationAuthorized:authorized]];
    }];
    installRequest(requests, @"org.scholarseed.test.sealed.ShipIt");
    dispatch_main();
  }
}
