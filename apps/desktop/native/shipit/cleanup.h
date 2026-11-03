#import <Foundation/Foundation.h>

// One process owns the installation/cleanup journal lock until exit.
BOOL SSCleanupClearRollback(NSString *label, NSString *key);
BOOL SSCleanupOpen(NSString *label, NSError **error);
BOOL SSCleanupOpenDirectory(NSString *directory, NSError **error);
BOOL SSCleanupCommit(NSURL *source, NSURL *stage, NSURL *previous, NSURL *target, NSURL *originalTarget, NSError **error);
BOOL SSCleanupKnowsRollback(NSURL *previous, NSURL *target);
BOOL SSCleanupReconcilesRollback(NSURL *previous, NSURL *target);
NSURL *SSCleanupRecoveredTarget(NSURL *source, NSURL *requestedTarget);
BOOL SSCleanupKnownRequest(NSURL *source);
BOOL SSCleanupCommittedRequest(NSURL *source, NSURL *target);
BOOL SSCleanupLaunchNeeded(NSURL *source, NSURL *target);
BOOL SSCleanupMarkLaunched(NSURL *source, NSURL *target);
BOOL SSCleanupDrain(NSURL *protectedTarget);
void SSCleanupClose(void);
