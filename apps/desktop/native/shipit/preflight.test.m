#define SS_PREFLIGHT_CONTRACT 1
#import "preflight.m"
#include <assert.h>

static SSProcessIdentity Identity(pid_t process, uid_t owner) {
    return (SSProcessIdentity){.process = process, .owner = owner, .real = owner, .saved = owner, .started = {.tv_sec = 100, .tv_usec = 123}, .status = SRUN};
}

static NSValue *Record(SSProcessIdentity identity) {
    return [NSValue valueWithBytes:&identity objCType:@encode(SSProcessIdentity)];
}

static SSPreparationActivity Coverage(NSArray *snapshots, BOOL (^readImage)(SSProcessIdentity, NSString **, BOOL *),
    NSString *(^canonicalize)(NSString *), double (^clock)(void), NSMutableDictionary *result) {
    __block NSUInteger index = 0;
    return ObserveActivity(502, 10, [NSURL fileURLWithPath:@"/Applications/Source App.app"], [NSURL fileURLWithPath:@"/Applications/Target App.app"],
        ^NSArray * {
            result[@"inventories"] = @(++index);
            return index <= snapshots.count ? snapshots[index - 1] : nil;
        }, readImage, canonicalize, clock, ^void(NSString *operation, int code, const SSInventoryDiagnostic *diagnostic, double started) {
            (void)diagnostic; (void)started;
            result[@"operation"] = operation;
            result[@"code"] = @(code);
        });
}

static NSUInteger CoverageContracts(void) {
    NSUInteger checks = 0;
    SSProcessIdentity observer = Identity(10, 502), root = Identity(20, 0), other = Identity(30, 503), fresh = Identity(40, 502);
    NSArray *initial = @[Record(observer), Record(root), Record(other)];
    NSArray *expanded = @[Record(observer), Record(root), Record(other), Record(fresh)];
    NSMutableDictionary *result = [NSMutableDictionary dictionary], *observations = [NSMutableDictionary dictionary];
    NSMutableDictionary *identityReads = [NSMutableDictionary dictionary], *imageReads = [NSMutableDictionary dictionary], *paths = [NSMutableDictionary dictionary];
    NSMutableSet *gone = [NSMutableSet set], *denied = [NSMutableSet set], *deniedImages = [NSMutableSet set], *changedImages = [NSMutableSet set];
    __block double now = 10;
    __block BOOL expireOnFresh = NO;
    void (^reset)(void) = ^ {
        [result removeAllObjects]; [observations removeAllObjects]; [identityReads removeAllObjects]; [imageReads removeAllObjects]; [paths removeAllObjects];
        [gone removeAllObjects]; [denied removeAllObjects]; [deniedImages removeAllObjects]; [changedImages removeAllObjects]; now = 10; expireOnFresh = NO;
    };
    double (^clock)(void) = ^double { return now; };
    NSString *(^canonicalize)(NSString *) = ^NSString *(NSString *path) { return path; };
    BOOL (^observe)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity expected, NSString **path, BOOL *exited) {
        NSNumber *key = @(expected.process);
        observations[key] = @([observations[key] unsignedIntegerValue] + 1);
        BOOL observed = ObserveImage(expected, ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            (void)process;
            identityReads[key] = @([identityReads[key] unsignedIntegerValue] + 1);
            if ([denied containsObject:key]) { errno = EPERM; return NO; }
            *identity = expected; *present = ![gone containsObject:key]; return YES;
        }, ^NSString *(pid_t process) {
            (void)process;
            imageReads[key] = @([imageReads[key] unsignedIntegerValue] + 1);
            if ([deniedImages containsObject:key]) { errno = EPERM; return nil; }
            if ([changedImages containsObject:key] && [imageReads[key] unsignedIntegerValue] == 2) return @"/different/image";
            return paths[key] ?: @"/usr/bin/true";
        }, path, exited);
        if (expireOnFresh && expected.process == fresh.process) now = 12;
        return observed;
    };
    reset();
    assert(Coverage(@[initial, initial], observe, canonicalize, clock, result) == SSPreparationActivityAbsent); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 2 && [observations[@20] unsignedIntegerValue] == 1); checks++;
    reset();
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityAbsent); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 3 && [observations[@40] unsignedIntegerValue] == 1); checks++;
    assert([identityReads[@40] unsignedIntegerValue] == 3 && [imageReads[@40] unsignedIntegerValue] == 2 && [observations[@20] unsignedIntegerValue] == 1); checks++;
    for (NSString *active in @[@"/Applications/Source App.app/Contents/MacOS/App", @"/Applications/Target App.app/Contents/Frameworks/Helper", @"/path/ShipIt"]) {
        reset(); paths[@40] = active;
        assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityActive); checks++;
        assert([result[@"inventories"] unsignedIntegerValue] == 2 && [observations[@40] unsignedIntegerValue] == 1); checks++;
    }
    reset(); paths[@20] = @"/path/ShipIt";
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityActive && [result[@"inventories"] unsignedIntegerValue] == 1); checks++;
    reset();
    NSArray *later = [expanded arrayByAddingObject:Record(Identity(41, 502))];
    assert(Coverage(@[initial, expanded, later], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 3 && !observations[@41] && [result[@"code"] intValue] == ESTALE); checks++;
    for (NSUInteger mutation = 0; mutation < 4; mutation++) {
        reset(); SSProcessIdentity changed = fresh;
        if (mutation == 0) changed.started.tv_usec++;
        if (mutation == 1) changed.owner++;
        if (mutation == 2) changed.real++;
        if (mutation == 3) changed.saved++;
        later = @[Record(observer), Record(root), Record(other), Record(changed)];
        assert(Coverage(@[initial, expanded, later], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
        assert([result[@"inventories"] unsignedIntegerValue] == 3 && [observations[@40] unsignedIntegerValue] == 1); checks++;
    }
    for (NSUInteger mutation = 0; mutation < 3; mutation++) {
        reset(); SSProcessIdentity changed = other;
        if (mutation == 0) changed.owner = 502;
        if (mutation == 1) changed.real = 502;
        if (mutation == 2) changed.saved = 502;
        later = @[Record(observer), Record(root), Record(changed)];
        assert(Coverage(@[initial, later], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
        assert([result[@"inventories"] unsignedIntegerValue] == 2 && !observations[@30]); checks++;
    }
    reset(); [gone addObject:@20];
    assert(Coverage(@[initial, initial], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 2 && [observations[@20] unsignedIntegerValue] == 1); checks++;
    reset(); [gone addObject:@20];
    NSArray *withoutRoot = @[Record(observer), Record(other)];
    assert(Coverage(@[initial, withoutRoot], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset(); [gone addObject:@20];
    NSArray *expandedWithoutRoot = [withoutRoot arrayByAddingObject:Record(fresh)];
    assert(Coverage(@[initial, expandedWithoutRoot, expanded], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset(); [gone addObject:@40];
    assert(Coverage(@[initial, expanded, initial], observe, canonicalize, clock, result) == SSPreparationActivityAbsent); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 3 && [identityReads[@40] unsignedIntegerValue] == 1 && !imageReads[@40]); checks++;
    reset(); [gone addObject:@40];
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 3 && [observations[@40] unsignedIntegerValue] == 1); checks++;
    reset(); SSProcessIdentity deadRoot = root; deadRoot.status = SZOMB;
    assert(Coverage(@[@[Record(observer), Record(deadRoot)], @[Record(observer), Record(root)]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
    reset(); SSProcessIdentity starting = fresh; starting.status = SIDL;
    assert(Coverage(@[initial, [initial arrayByAddingObject:Record(starting)]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && !observations[@40]); checks++;
    reset();
    assert(Coverage(@[initial, expanded, [initial arrayByAddingObject:Record(starting)]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset(); [denied addObject:@20];
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 1 && [identityReads[@20] unsignedIntegerValue] == 1 && !observations[@40]); checks++;
    reset(); [denied addObject:@40];
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 2 && [identityReads[@40] unsignedIntegerValue] == 1 && !imageReads[@40]); checks++;
    reset(); [deniedImages addObject:@40];
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [imageReads[@40] unsignedIntegerValue] == 1); checks++;
    reset(); [changedImages addObject:@40];
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [imageReads[@40] unsignedIntegerValue] == 2 && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset(); paths[@40] = @"/unavailable/image";
    assert(Coverage(@[initial, expanded, expanded], observe, ^NSString *(NSString *path) { return [path isEqual:@"/unavailable/image"] ? nil : path; }, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset();
    assert(Coverage(@[initial, @[Record(root)]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset();
    assert(Coverage(@[initial, expanded, @[Record(root)]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    NSMutableArray *many = [initial mutableCopy];
    for (pid_t process = 40; process < 49; process++) [many addObject:Record(Identity(process, 502))];
    reset(); paths[@48] = @"/path/ShipIt";
    assert(Coverage(@[initial, many, many], observe, canonicalize, clock, result) == SSPreparationActivityActive && [observations[@48] unsignedIntegerValue] == 1); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 2 && observations.count == 11); checks++;
    reset();
    assert(Coverage(@[initial, many, many], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && observations.count == 11 && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset();
    double (^expiredAfterMiddle)(void) = ^double { return [result[@"inventories"] unsignedIntegerValue] >= 2 ? 12 : 10; };
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, expiredAfterMiddle, result) == SSPreparationActivityUnknown && !observations[@40]); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 2 && [result[@"code"] intValue] == ETIMEDOUT); checks++;
    reset(); expireOnFresh = YES;
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 2 && [observations[@40] unsignedIntegerValue] == 1); checks++;
    reset();
    double (^expiredAfterClosure)(void) = ^double { return [result[@"inventories"] unsignedIntegerValue] >= 3 ? 12 : 10; };
    assert(Coverage(@[initial, expanded, expanded], observe, canonicalize, expiredAfterClosure, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 3 && [result[@"code"] intValue] == ETIMEDOUT); checks++;
    reset();
    assert(Coverage(@[initial, initial], observe, canonicalize, expiredAfterMiddle, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset();
    SSProcessIdentity renamed = root; renamed.parentPidAtSnapshot = 999; memcpy(renamed.reportedName, "ShipIt", sizeof("ShipIt"));
    assert(Coverage(@[initial, @[Record(observer), Record(renamed), Record(other)]], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset();
    NSArray *otherAdded = [initial arrayByAddingObject:Record(Identity(41, 503))];
    assert(Coverage(@[initial, otherAdded], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && !observations[@41] && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset();
    assert(Coverage(@[initial, expanded, [expanded arrayByAddingObject:Record(Identity(41, 503))]], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && !observations[@41] && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    for (NSUInteger mutation = 0; mutation < 4; mutation++) {
        reset(); SSProcessIdentity changed = root;
        if (mutation == 0) changed.started.tv_usec++;
        if (mutation == 1) changed.owner++;
        if (mutation == 2) changed.real++;
        if (mutation == 3) changed.saved++;
        later = @[Record(observer), Record(fresh), Record(changed), Record(other)];
        assert(Coverage(@[initial, later], observe, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
        assert([result[@"inventories"] unsignedIntegerValue] == 2 && !observations[@40] && [observations[@20] unsignedIntegerValue] == 1); checks++;
    }
    reset(); starting = root; starting.status = SIDL;
    assert(Coverage(@[initial, @[Record(observer), Record(starting), Record(other)]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset(); SSProcessIdentity changedOther = other; changedOther.real = 502;
    later = @[Record(observer), Record(root), Record(changedOther), Record(fresh)];
    assert(Coverage(@[initial, expanded, later], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && !observations[@30] && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset(); SSProcessIdentity zombieFresh = Identity(41, 502); zombieFresh.status = SZOMB;
    NSArray *withZombie = [expanded arrayByAddingObject:Record(zombieFresh)];
    assert(Coverage(@[initial, withZombie, [expanded arrayByAddingObject:Record(Identity(41, 502))]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && !observations[@41] && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset();
    assert(Coverage(@[initial, withZombie, withZombie], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && !observations[@41] && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset();
    assert(Coverage(@[initial, [initial arrayByAddingObject:Record(observer)]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset();
    assert(Coverage(@[initial, expanded, [expanded arrayByAddingObject:Record(observer)]], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset();
    assert(Coverage(@[initial], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset();
    assert(Coverage(@[initial, expanded], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset();
    assert(Coverage(@[initial, expanded], observe, canonicalize, ^double { return -1; }, result) == SSPreparationActivityUnknown && !result[@"inventories"]); checks++;
    reset(); paths[@40] = @"/alias/image";
    assert(Coverage(@[initial, expanded], observe, ^NSString *(NSString *path) { return [path isEqual:@"/alias/image"] ? @"/Applications/Target App.app/Contents/MacOS/App" : path; }, clock, result) == SSPreparationActivityActive && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset(); SSProcessIdentity rootFresh = Identity(40, 0);
    NSArray *rootExpanded = [initial arrayByAddingObject:Record(rootFresh)];
    assert(Coverage(@[initial, rootExpanded, rootExpanded], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && [identityReads[@40] unsignedIntegerValue] == 3 && [imageReads[@40] unsignedIntegerValue] == 2); checks++;
    reset(); SSProcessIdentity savedFresh = Identity(40, 503); savedFresh.saved = 502;
    NSArray *savedExpanded = [initial arrayByAddingObject:Record(savedFresh)];
    assert(Coverage(@[initial, savedExpanded, savedExpanded], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && [identityReads[@40] unsignedIntegerValue] == 3 && [imageReads[@40] unsignedIntegerValue] == 2); checks++;
    reset();
    assert(Coverage(@[initial, expandedWithoutRoot, expandedWithoutRoot], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && [observations[@40] unsignedIntegerValue] == 1 && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset();
    later = @[Record(observer), Record(other), Record(Identity(41, 502))];
    assert(Coverage(@[initial, expandedWithoutRoot, later], observe, canonicalize, clock, result) == SSPreparationActivityUnknown && !observations[@41] && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset(); renamed = fresh; renamed.parentPidAtSnapshot = 999; memcpy(renamed.reportedName, "ShipIt", sizeof("ShipIt"));
    assert(Coverage(@[initial, expanded, [initial arrayByAddingObject:Record(renamed)]], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && [result[@"inventories"] unsignedIntegerValue] == 3); checks++;
    reset(); starting = root; starting.status = SIDL;
    __block NSUInteger startingObservations = 0, startingIdentities = 0, startingImages = 0;
    BOOL (^becameLive)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity expected, NSString **path, BOOL *exited) {
        if (expected.process == root.process) startingObservations++;
        return ObserveImage(expected, ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            if (process == root.process) startingIdentities++;
            *identity = expected; identity->status = SRUN; *present = YES; return YES;
        }, ^NSString *(pid_t process) {
            if (process == root.process) startingImages++;
            return @"/usr/bin/true";
        }, path, exited);
    };
    assert(Coverage(@[@[Record(observer), Record(starting), Record(other)], initial], becameLive, canonicalize, clock, result) == SSPreparationActivityUnknown); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 1 && startingObservations == 0 && startingIdentities == 0 && startingImages == 0); checks++;
    reset(); SSProcessIdentity outsideRoot = root;
    outsideRoot.owner = outsideRoot.real = outsideRoot.saved = 503;
    NSArray *outsideInitial = @[Record(observer), Record(outsideRoot), Record(other)];
    SSPreparationActivity initialOutward = Coverage(@[initial, outsideInitial], observe, canonicalize, clock, result);
    NSUInteger initialOutwardSnapshots = [result[@"inventories"] unsignedIntegerValue], initialOutwardObservations = [observations[@20] unsignedIntegerValue];
    reset(); SSProcessIdentity outsideFresh = fresh;
    outsideFresh.owner = outsideFresh.real = outsideFresh.saved = 503;
    SSPreparationActivity closureOutward = Coverage(@[initial, expanded, [initial arrayByAddingObject:Record(outsideFresh)]], observe, canonicalize, clock, result);
    fprintf(stderr, "preflight-contract stage=pair-scope-results initial=%ld closure=%ld expected=%ld\n", (long)initialOutward, (long)closureOutward, (long)SSPreparationActivityUnknown);
    fflush(stderr);
    assert(initialOutward == SSPreparationActivityUnknown); checks++;
    assert(initialOutwardSnapshots == 2 && initialOutwardObservations == 1); checks++;
    assert(closureOutward == SSPreparationActivityUnknown); checks++;
    assert([result[@"inventories"] unsignedIntegerValue] == 3 && [observations[@40] unsignedIntegerValue] == 1); checks++;
    reset(); changedOther = other; changedOther.owner = changedOther.real = changedOther.saved = 504; changedOther.started.tv_usec++;
    assert(Coverage(@[initial, @[Record(observer), Record(root), Record(changedOther)]], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && !observations[@30] && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    reset(); outsideRoot.status = SZOMB;
    assert(Coverage(@[initial, @[Record(observer), Record(outsideRoot), Record(other)]], observe, canonicalize, clock, result) == SSPreparationActivityAbsent && [result[@"inventories"] unsignedIntegerValue] == 2); checks++;
    return checks;
}

int main(void) {
    fprintf(stderr, "preflight-contract stage=main-enter\n");
    fflush(stderr);
    @autoreleasepool {
        NSURL *source = [NSURL fileURLWithPath:@"/Applications/Source App.app"];
        NSURL *target = [NSURL fileURLWithPath:@"/Applications/Target App.app"];
        SSProcessIdentity observer = Identity(10, 502), root = Identity(20, 0), other = Identity(30, 503);
        NSArray *inventory = @[Record(observer), Record(root), Record(other)];
        NSString *(^canonical)(NSString *) = ^NSString *(NSString *path) { return path; };
        SSProcessIdentityRead stable = ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            *identity = process == 10 ? observer : process == 20 ? root : other;
            *present = YES;
            return YES;
        };
        SSProcessImageRead unrelated = ^NSString *(pid_t process) { (void)process; return @"/usr/bin/true"; };
        BOOL (^image)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity expected, NSString **path, BOOL *exited) {
            return ObserveImage(expected, stable, unrelated, path, exited);
        };
        NSUInteger checks = 0;
        SSProcessIdentity ownedHelper = Identity(21, 502), replacementHelper = ownedHelper;
        replacementHelper.started.tv_usec++;
        NSString *ownedImage = @"/Applications/Target App.app/Contents/Frameworks/Squirrel.framework/Resources/ShipIt";
        BOOL (^parkingImage)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity identity, NSString **path, BOOL *exited) {
            *exited = NO; *path = identity.process == observer.process ? @"/usr/bin/true" : ownedImage; return YES;
        };
        SSProcessExemption parking = ^BOOL(SSProcessIdentity identity, NSString *path) {
            return EqualProcess(identity, ownedHelper) && [path isEqual:ownedImage];
        };
        NSArray *parkingInventory = @[Record(observer), Record(ownedHelper)];
        assert(ClassifyActivity(parkingInventory, 502, 10, source, target, parkingImage, canonical, nil) == SSPreparationActivityActive); checks++;
        assert(ClassifyActivityPolicy(parkingInventory, 502, 10, source, target, parkingImage, canonical, nil, parking) == SSPreparationActivityAbsent); checks++;
        assert(ClassifyActivityPolicy(@[Record(observer), Record(replacementHelper)], 502, 10, source, target, parkingImage, canonical, nil, parking) == SSPreparationActivityActive); checks++;
        assert(ClassifyActivityPolicy(@[Record(observer), Record(ownedHelper), Record(root)], 502, 10, source, target, parkingImage, canonical, nil, parking) == SSPreparationActivityActive); checks++;
        assert(ClassifyActivityPolicy(parkingInventory, 502, 10, source, target, ^BOOL(SSProcessIdentity identity, NSString **path, BOOL *exited) {
            *exited = NO; *path = identity.process == observer.process ? @"/usr/bin/true" : @"/Applications/Target App.app/Contents/MacOS/App"; return YES;
        }, canonical, nil, parking) == SSPreparationActivityActive); checks++;
        assert(ClassifyActivity(inventory, 502, 10, source, target, image, canonical, nil) == SSPreparationActivityAbsent); checks++;
        assert(ClassifyActivity(@[], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        assert(ClassifyActivity(@[Record(root)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        assert(ClassifyActivity(@[Record(other)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        assert(ClassifyActivity(@[Record(observer), Record(observer)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        assert(ClassifyActivity(@[@1], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        SSProcessIdentity malformed = observer;
        malformed.process = -1;
        assert(ClassifyActivity(@[Record(malformed)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        malformed = observer; malformed.started.tv_sec = 0;
        assert(ClassifyActivity(@[Record(malformed)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        malformed = observer; malformed.started.tv_usec = 1000000;
        assert(ClassifyActivity(@[Record(malformed)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        malformed = observer; malformed.status = 0;
        assert(ClassifyActivity(@[Record(malformed)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityUnknown); checks++;
        assert(ClassifyActivity(inventory, 502, 10, source, target, image, nil, nil) == SSPreparationActivityUnknown); checks++;
        for (NSString *executable in @[@"/Applications/Source App.app/Contents/MacOS/App", @"/Applications/Target App.app/Contents/Frameworks/Helper", @"/path/ShipIt"]) {
            SSProcessImageRead rewrittenDisplayName = ^NSString *(pid_t process) { return process == 20 ? executable : @"/usr/bin/true"; };
            BOOL (^activeImage)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity expected, NSString **path, BOOL *exited) {
                return ObserveImage(expected, stable, rewrittenDisplayName, path, exited);
            };
            assert(ClassifyActivity(inventory, 502, 10, source, target, activeImage, canonical, nil) == SSPreparationActivityActive); checks++;
            assert(ClassifyActivity(inventory, 502, 10, source, target, activeImage, ^NSString *(NSString *path) {
                return [path isEqual:@"/usr/bin/true"] ? path : nil;
            }, nil) == SSPreparationActivityActive); checks++;
        }
        assert(ClassifyActivity(inventory, 502, 10, source, target, image, ^NSString *(NSString *path) { (void)path; return nil; }, nil) == SSPreparationActivityUnknown); checks++;
        for (NSString *alias in @[@"/Applications/Source App.app/Contents/MacOS/App", @"/different/ShipIt"]) {
            assert(ClassifyActivity(inventory, 502, 10, source, target, image, ^NSString *(NSString *path) { (void)path; return alias; }, nil) == SSPreparationActivityActive); checks++;
        }
        SSProcessIdentityRead denied = ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            (void)process; (void)identity; (void)present; errno = EPERM; return NO;
        };
        NSString *path = nil;
        BOOL exited = NO;
        assert(!ObserveImage(observer, denied, unrelated, &path, &exited)); checks++;
        SSProcessImageRead inaccessible = ^NSString *(pid_t process) { (void)process; errno = EPERM; return nil; };
        assert(!ObserveImage(observer, stable, inaccessible, &path, &exited)); checks++;
        SSProcessIdentityRead gone = ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            (void)process; (void)identity; *present = NO; return YES;
        };
        assert(ObserveImage(observer, gone, unrelated, &path, &exited) && exited); checks++;
        __block NSUInteger goneReads = 0;
        SSProcessIdentityRead disappeared = ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            (void)process; *identity = observer; *present = ++goneReads == 1; return YES;
        };
        SSProcessImageRead vanished = ^NSString *(pid_t process) { (void)process; errno = ESRCH; return nil; };
        assert(ObserveImage(observer, disappeared, vanished, &path, &exited) && exited); checks++;
        goneReads = 0;
        assert(!ObserveImage(observer, disappeared, inaccessible, &path, &exited)); checks++;
        SSProcessIdentity zombie = observer; zombie.status = SZOMB;
        assert(ObserveImage(zombie, denied, inaccessible, &path, &exited) && exited); checks++;
        SSProcessIdentityRead nowZombie = ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            (void)process; *identity = zombie; *present = YES; return YES;
        };
        assert(ObserveImage(observer, nowZombie, inaccessible, &path, &exited) && exited); checks++;
        for (NSUInteger mutation = 0; mutation < 5; mutation++) {
            __block NSUInteger reads = 0;
            SSProcessIdentityRead changed = ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
                (void)process; *identity = observer; *present = YES;
                if (++reads == 2) {
                    if (mutation == 0) identity->started.tv_usec++;
                    if (mutation == 1) identity->owner++;
                    if (mutation == 2) identity->real++;
                    if (mutation == 3) identity->saved++;
                    if (mutation == 4) identity->process++;
                }
                return YES;
            };
            assert(!ObserveImage(observer, changed, unrelated, &path, &exited)); checks++;
        }
        __block NSUInteger paths = 0;
        SSProcessImageRead replaced = ^NSString *(pid_t process) { (void)process; return ++paths == 1 ? @"/usr/bin/true" : @"/Applications/Source App.app/Contents/MacOS/App"; };
        assert(!ObserveImage(observer, stable, replaced, &path, &exited)); checks++;
        for (NSString *invalid in @[@"node", @"", @"/path\tinvalid"]) {
            SSProcessImageRead invalidImage = ^NSString *(pid_t process) { (void)process; return invalid; };
            BOOL (^readInvalid)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity expected, NSString **result, BOOL *ended) {
                return ObserveImage(expected, stable, invalidImage, result, ended);
            };
            assert(ClassifyActivity(inventory, 502, 10, source, target, readInvalid, canonical, nil) == SSPreparationActivityUnknown); checks++;
        }
        SSProcessIdentity saved = other; saved.saved = 502;
        __block BOOL savedObserved = NO;
        BOOL (^savedImage)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity expected, NSString **result, BOOL *ended) {
            *ended = NO; *result = expected.process == 30 ? @"/path/ShipIt" : @"/usr/bin/true";
            savedObserved = savedObserved || expected.process == 30;
            return YES;
        };
        assert(ClassifyActivity(@[Record(observer), Record(saved)], 502, 10, source, target, savedImage, canonical, nil) == SSPreparationActivityActive && savedObserved); checks++;
        SSProcessIdentity kernel = Identity(0, 0);
        assert(ClassifyActivity(@[Record(observer), Record(kernel)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityAbsent); checks++;
        assert(SameInventory(inventory, inventory, 502, 10, NULL)); checks++;
        assert(!SameInventory(inventory, @[], 502, 10, NULL)); checks++;
        assert(!SameInventory(inventory, @[Record(observer), Record(root), Record(Identity(40, 502))], 502, 10, NULL)); checks++;
        SSProcessIdentity reused = root; reused.started.tv_sec++;
        assert(!SameInventory(inventory, @[Record(observer), Record(reused)], 502, 10, NULL)); checks++;
        assert(SameInventory(inventory, @[Record(observer)], 502, 10, NULL)); checks++;
        assert(!SameInventory(inventory, @[Record(observer), Record(observer)], 502, 10, NULL)); checks++;
        SSProcessIdentity starting = root; starting.status = SIDL;
        assert(!SameInventory(inventory, @[Record(observer), Record(starting)], 502, 10, NULL)); checks++;
        SSInventoryDiagnostic diagnostic;
        errno = EDOM;
        assert(!SameInventory(inventory, @[Record(observer), Record(root), Record(Identity(40, 502))], 502, 10, &diagnostic) && errno == EDOM); checks++;
        assert(diagnostic.valid && diagnostic.beforeCount == inventory.count && diagnostic.afterCount == 3 && diagnostic.total == 1 && diagnostic.count == 1); checks++;
        assert(diagnostic.differences[0].kind == SSProcessDifferenceNew && !diagnostic.differences[0].hasBefore && diagnostic.differences[0].after.process == 40); checks++;
        assert(!strcmp(DifferenceName(diagnostic.differences[0].kind), "new")); checks++;
        assert(!SameInventory(inventory, @[Record(observer), Record(reused)], 502, 10, &diagnostic)); checks++;
        assert(diagnostic.count == 1 && diagnostic.differences[0].kind == SSProcessDifferenceReused && diagnostic.differences[0].hasBefore && diagnostic.differences[0].before.started.tv_sec == root.started.tv_sec && diagnostic.differences[0].after.started.tv_sec == reused.started.tv_sec); checks++;
        SSProcessIdentity deadRoot = root; deadRoot.status = SZOMB;
        assert(!SameInventory(@[Record(observer), Record(deadRoot)], @[Record(observer), Record(root)], 502, 10, &diagnostic)); checks++;
        assert(diagnostic.count == 1 && diagnostic.differences[0].kind == SSProcessDifferenceZombieToLive); checks++;
        assert(!SameInventory(inventory, @[Record(observer), Record(starting)], 502, 10, &diagnostic)); checks++;
        assert(diagnostic.count == 1 && diagnostic.differences[0].kind == SSProcessDifferenceStarting); checks++;
        NSMutableArray *many = [NSMutableArray arrayWithObjects:Record(observer), Record(root), nil];
        for (pid_t process = 100; process < 132; process++) [many addObject:Record(Identity(process, 502))];
        assert(!SameInventory(inventory, many, 502, 10, &diagnostic)); checks++;
        assert(diagnostic.total == 32 && diagnostic.count == SS_PREFLIGHT_DIFFERENCE_LIMIT && diagnostic.count < diagnostic.total); checks++;
        for (NSUInteger index = 0; index < diagnostic.count; index++) {
            assert(diagnostic.differences[index].kind == SSProcessDifferenceNew && diagnostic.differences[index].after.process >= 100 && diagnostic.differences[index].after.process < 132); checks++;
        }
        assert(SameInventory(inventory, @[Record(observer), Record(Identity(40, 503))], 502, 10, &diagnostic) && diagnostic.total == 0 && diagnostic.count == 0); checks++;
        assert(SameInventory(inventory, @[Record(observer)], 502, 10, &diagnostic) && diagnostic.total == 0); checks++;
        assert(!SameInventory(inventory, @[], 502, 10, &diagnostic) && !diagnostic.valid && diagnostic.count == 0); checks++;
        struct kinfo_proc snapshot = {0};
        snapshot.kp_proc.p_pid = root.process;
        snapshot.kp_proc.p_starttime = root.started;
        snapshot.kp_proc.p_stat = root.status;
        snapshot.kp_eproc.e_ucred.cr_uid = root.owner;
        snapshot.kp_eproc.e_pcred.p_ruid = root.real;
        snapshot.kp_eproc.e_pcred.p_svuid = root.saved;
        snapshot.kp_eproc.e_ppid = 7;
        memcpy(snapshot.kp_proc.p_comm, "node-runtime", sizeof("node-runtime"));
        errno = EDOM;
        SSProcessIdentity reported = KernelIdentity(snapshot);
        assert(EqualProcess(reported, root) && errno == EDOM); checks++;
        assert(reported.parentPidAtSnapshot == 7 && !memcmp(reported.reportedName, snapshot.kp_proc.p_comm, sizeof(reported.reportedName))); checks++;
        assert([ReportedName(reported) isEqual:@"node-runtime"] && errno == EDOM); checks++;
        memset(snapshot.kp_proc.p_comm, 'x', sizeof(snapshot.kp_proc.p_comm));
        reported = KernelIdentity(snapshot);
        assert([ReportedName(reported) length] == sizeof(snapshot.kp_proc.p_comm)); checks++;
        const unsigned char unsafeName[] = {'n', 'o', 'd', 'e', '\n', '"', '\\', 0xff, 0, 't'};
        memset(snapshot.kp_proc.p_comm, 0, sizeof(snapshot.kp_proc.p_comm));
        memcpy(snapshot.kp_proc.p_comm, unsafeName, sizeof(unsafeName));
        reported = KernelIdentity(snapshot);
        assert([ReportedName(reported) isEqual:@"node\\x0a\\x22\\x5c\\xff"] && errno == EDOM); checks++;
        memset(reported.reportedName, 0xff, sizeof(reported.reportedName));
        assert([ReportedName(reported) length] == sizeof(reported.reportedName) * 4); checks++;
        assert([ReportedName(Identity(40, 502)) isEqual:@""]); checks++;
        SSProcessIdentity renamed = root;
        renamed.parentPidAtSnapshot = 999;
        memcpy(renamed.reportedName, "ShipIt", sizeof("ShipIt"));
        assert(EqualProcess(renamed, root) && ValidProcess(renamed)); checks++;
        assert(SameInventory(inventory, @[Record(observer), Record(renamed), Record(other)], 502, 10, &diagnostic) && diagnostic.total == 0); checks++;
        assert(ClassifyActivity(@[Record(observer), Record(renamed)], 502, 10, source, target, image, canonical, nil) == SSPreparationActivityAbsent); checks++;
        SSProcessIdentityRead renamedIdentity = ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            (void)process; *identity = renamed; *present = YES; return YES;
        };
        assert(ObserveImage(root, renamedIdentity, unrelated, &path, &exited) && !exited && [path isEqual:@"/usr/bin/true"]); checks++;
        SSProcessImageRead activeReportedImage = ^NSString *(pid_t process) { (void)process; return @"/Applications/Source App.app/Contents/MacOS/App"; };
        BOOL (^activeReported)(SSProcessIdentity, NSString **, BOOL *) = ^BOOL(SSProcessIdentity expected, NSString **result, BOOL *ended) {
            return ObserveImage(expected, renamedIdentity, activeReportedImage, result, ended);
        };
        assert(ClassifyActivity(@[Record(root)], 0, 20, source, target, activeReported, canonical, nil) == SSPreparationActivityActive); checks++;
        assert(!ObserveImage(renamed, denied, unrelated, &path, &exited)); checks++;
        SSProcessIdentity newReported = Identity(40, 502);
        newReported.parentPidAtSnapshot = observer.process;
        memcpy(newReported.reportedName, "node", sizeof("node"));
        errno = EDOM;
        assert(!SameInventory(inventory, @[Record(observer), Record(root), Record(newReported)], 502, 10, &diagnostic) && errno == EDOM); checks++;
        assert(diagnostic.count == 1 && diagnostic.differences[0].kind == SSProcessDifferenceNew && diagnostic.differences[0].after.parentPidAtSnapshot == observer.process && [ReportedName(diagnostic.differences[0].after) isEqual:@"node"]); checks++;
        renamed.started.tv_usec++;
        assert(!SameInventory(inventory, @[Record(observer), Record(renamed)], 502, 10, &diagnostic) && diagnostic.differences[0].kind == SSProcessDifferenceReused); checks++;
        fprintf(stderr, "preflight-contract stage=coverage-start\n");
        fflush(stderr);
        checks += CoverageContracts();
        fprintf(stderr, "preflight-contract stage=coverage-end\n");
        fflush(stderr);
        starting = root; starting.status = SIDL;
        __block NSUInteger startingIdentityReads = 0, startingImageReads = 0;
        SSProcessIdentityRead becameLive = ^BOOL(pid_t process, SSProcessIdentity *identity, BOOL *present) {
            (void)process; startingIdentityReads++; *identity = root; *present = YES; return YES;
        };
        SSProcessImageRead startingImage = ^NSString *(pid_t process) { (void)process; startingImageReads++; return @"/usr/bin/true"; };
        assert(!ObserveImage(starting, becameLive, startingImage, &path, &exited)); checks++;
        assert(startingIdentityReads == 0 && startingImageReads == 0 && !exited); checks++;
        NSLog(@"preflight kernel observation checks passed=%lu", (unsigned long)checks);
    }
    return 0;
}
