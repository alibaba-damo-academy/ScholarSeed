/** All visible onboarding copy is resolved through this one key catalogue.
 * Wording lives in localization/locales/{zh,en}/onboarding.json.
 * 待定: project.discovery, project.ai, globalLib.discovery, pdf.figure,
 * pdf.selection and pdf.ai retain the supplied wording pending product review.
 */
export const OB_COPY = {
  "center": "center",
  "view": "view",
  "seen": "seen",
  "unseen": "unseen",
  "reset": "reset",
  "done": "done",
  "skip": "skip",
  "next": "next",
  "start": "start",
  "step": "step",
  "noProject": "noProject",
  "sample": "sample",
  "sampleTitle": "sampleTitle",
  "sampleLimited": "sampleLimited",
  "unavailable": "unavailable",
  "noPdf": "noPdf",
  "openFailed": "openFailed",
  "home": {
    "name": "home.name",
    "description": "home.description",
    "title": "home.title",
    "literatureTitle": "home.literatureTitle",
    "literatureBody": "home.literatureBody",
    "literatureLink": "home.literatureLink",
    "projectTitle": "home.projectTitle",
    "projectBody": "home.projectBody",
    "projectLink": "home.projectLink",
    "browse": "home.browse"
  },
  "project": {
    "name": "project.name",
    "description": "project.description",
    "switcher": {
      "title": "project.switcher.title",
      "body": "project.switcher.body"
    },
    "resources": {
      "title": "project.resources.title",
      "body": "project.resources.body"
    },
    "discovery": {
      "title": "project.discovery.title",
      "body": "project.discovery.body"
    },
    "literature": {
      "title": "project.literature.title",
      "body": "project.literature.body"
    },
    "ai": {
      "title": "project.ai.title",
      "body": "project.ai.body"
    }
  },
  "globalLib": {
    "name": "globalLib.name",
    "description": "globalLib.description",
    "library": {
      "title": "globalLib.library.title",
      "body": "globalLib.library.body"
    },
    "import": {
      "title": "globalLib.import.title",
      "body": "globalLib.import.body"
    },
    "discovery": {
      "title": "globalLib.discovery.title",
      "body": "globalLib.discovery.body"
    },
    "categories": {
      "title": "globalLib.categories.title",
      "body": "globalLib.categories.body"
    },
    "ai": {
      "title": "globalLib.ai.title",
      "body": "globalLib.ai.body"
    }
  },
  "pdf": {
    "sampleSelection": {
      "title": "pdf.sampleSelection.title",
      "body": "pdf.sampleSelection.body"
    },
    "name": "pdf.name",
    "description": "pdf.description",
    "figure": {
      "title": "pdf.figure.title",
      "body": "pdf.figure.body"
    },
    "tools": {
      "title": "pdf.tools.title",
      "body": "pdf.tools.body"
    },
    "selection": {
      "title": "pdf.selection.title",
      "body": "pdf.selection.body"
    },
    "ai": {
      "title": "pdf.ai.title",
      "body": "pdf.ai.body"
    }
  }
} as const
