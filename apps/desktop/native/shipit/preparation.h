#import <Foundation/Foundation.h>

// The installer holds SSCleanupOpen's lock as well for the complete lifecycle.
BOOL SSPreparationOpen(NSString *label, NSError **error);
BOOL SSPreparationOpenDirectory(NSString *directory, NSError **error);
BOOL SSPreparationOpenExistingDirectory(NSString *directory, NSError **error);
int SSPreparationUncertaintyCode(void);
typedef NS_ENUM(NSInteger, SSPreparationActivity) {
    SSPreparationActivityUnknown = -1,
    SSPreparationActivityActive = 0,
    SSPreparationActivityAbsent = 1,
};
NSDictionary *SSPreparationFailureSnapshot(NSURL *source, NSURL *target, NSDictionary *binding,
    NSURL *state, SSPreparationActivity (^activity)(void), NSError **error);
// Prepare before waiting for termination. Reuse does not replace signature validation.
NSURL *SSPreparationCopy(NSURL *source, NSURL *target, NSDictionary *binding, NSError **error);
BOOL SSPreparationValidate(NSURL *source, NSURL *target, NSDictionary *binding, NSURL *candidate, NSError **error);
// Persist intent before any ownership mutation; an interrupted intent can only fail.
BOOL SSPreparationBeginOwnership(NSURL *source, NSURL *target, NSDictionary *binding, NSURL *candidate, NSError **error);
// Called only after the installer's ownership operation and signature check.
// Rebase owners, never the request, parent, bundle or Contents inode identities.
BOOL SSPreparationAcceptOwnership(NSURL *source, NSURL *target, NSDictionary *binding, NSURL *candidate, NSError **error);
typedef NS_ENUM(NSInteger, SSPreparationFailure) {
    SSPreparationFailureInvalid = -1,
    SSPreparationFailureNone = 0,
    SSPreparationFailureRestored = 1,
};
BOOL SSPreparationRecordFailure(NSURL *source, NSURL *actualTarget, NSDictionary *binding, NSInteger code, NSError **error);
SSPreparationFailure SSPreparationRecoverFailure(NSURL *source, NSURL *target, NSDictionary *binding, NSInteger *code, NSError **error);
// Publish terminal evidence before invoking the existing native launch protocol.
// A successful launch is durable; callbacks never grant installation authority.
BOOL SSPreparationFinishFailure(NSURL *source, NSURL *target, NSDictionary *binding, BOOL authorized,
    BOOL (^running)(void), BOOL (^launch)(void), NSError **error);
BOOL SSPreparationRetire(NSURL *source, NSURL *target, NSError **error);
void SSPreparationClose(void);
BOOL SSPreparationCloseChecked(NSError **error);
