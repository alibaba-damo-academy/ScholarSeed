/* SPDX-License-Identifier: MIT */
#include <fontconfig/fontconfig.h>
#include <unistd.h>

/* Same application directories and ordering as the frozen Office engine.
 * Its configuration resets system directories; app fonts are added separately. */
static const char *font_directories[] = {
    "/instdir/program/resource/common/fonts",
    "/instdir/share/fonts/truetype"
};

int generate(void) {
    FcConfig *config = FcInitLoadConfigAndFonts();
    if (!config) return -1;
    FcConfigSetCurrent(config);
    int result = -1;
    for (unsigned i = 0; i < sizeof(font_directories) / sizeof(font_directories[0]); ++i) {
        const FcChar8 *directory = (const FcChar8 *)font_directories[i];
        if (!FcConfigAppFontAddDir(config, directory) || !FcDirCacheValid(directory)) goto done;
    }
    FcFontSet *fonts = FcConfigGetFonts(config, FcSetApplication);
    if (fonts && fonts->nfont > 0) result = fonts->nfont;
done:
    FcConfigDestroy(config);
    FcFini();
    return result;
}
