#import <Foundation/Foundation.h>

// One process owns the installation/cleanup journal lock until exit.
BOOL SSCleanupClearRollback(NSString *label, NSString *key);
BOOL SSCleanupOpen(NSString *label, NSError **error);
BOOL SSCleanupOpenDirectory(NSString *directory, NSError **error);
BOOL SSCleanupOpenExistingDirectory(NSString *directory, NSError **error);
BOOL SSCleanupOpenMaintenanceDirectory(NSString *directory, NSError **error);
NSDictionary *SSCleanupReadOnlySnapshot(NSError **error);
NSDictionary *SSCleanupMaintenanceSnapshot(NSError **error);
NSDictionary *SSCleanupIdleMaintenanceSnapshot(NSError **error);
BOOL SSCleanupCommit(NSURL *source, NSURL *stage, NSURL *previous, NSURL *target, NSURL *originalTarget, NSError **error);
BOOL SSCleanupKnowsRollback(NSURL *previous, NSURL *target);
BOOL SSCleanupReconcilesRollback(NSURL *previous, NSURL *target);
NSURL *SSCleanupRecoveredTarget(NSURL *source, NSURL *requestedTarget);
BOOL SSCleanupKnownRequest(NSURL *source);
BOOL SSCleanupCommittedRequest(NSURL *source, NSURL *target);
// preparation.m supplies Capture(path, YES) snapshots for the source, staged
// candidate and installed target. Each has a physical path and parent, item
// and contents identities (dev, ino, uid). originalTarget is the path from the
// prepared target snapshot, which can differ from the installed target's name.
BOOL SSCleanupConfirmsCopiedCandidate(NSDictionary *source, NSDictionary *candidate, NSDictionary *installed, NSString *originalTarget);
BOOL SSCleanupObservedLaunch(NSURL *source, NSURL *target, NSError **error);
BOOL SSCleanupLaunchNeeded(NSURL *source, NSURL *target);
BOOL SSCleanupMarkLaunched(NSURL *source, NSURL *target);
BOOL SSCleanupDrain(NSURL *protectedTarget);
void SSCleanupClose(void);
BOOL SSCleanupCloseChecked(NSError **error);
