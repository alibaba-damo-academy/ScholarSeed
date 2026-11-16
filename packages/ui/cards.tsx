import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { LiteratureResults } from "../../apps/desktop/src/renderer/src/features/literature/Summary";
import { LiteratureDetails } from "../../apps/desktop/src/renderer/src/features/literature/Details";
import { LiteratureReviewCard } from "../../apps/desktop/src/renderer/src/features/literature/Review";
import {
  literatureCopy,
  reviewCopy,
} from "../../apps/desktop/src/renderer/src/features/literature/copy";
import { useCopyContent, withCopyText } from "./copying";
import { MarkdownContent } from "../../apps/desktop/src/renderer/src/components/primitive/Markdown";
import { Formula as FormulaView } from "../../apps/desktop/src/renderer/src/components/primitive/Formula";
import { Tabulation as TabulationView } from "../../apps/desktop/src/renderer/src/components/primitive/Tabulation";
import { Artifact as ArtifactView } from "../../apps/desktop/src/renderer/src/components/business/Artifact";
import { artifactText } from "../../apps/desktop/src/renderer/src/components/business/representation";
import { visibleMarkdownText } from "../../apps/desktop/src/markdown/source.ts";

function card<Props extends object>(
  View: React.ComponentType<Props>,
  content: (props: Props, translate: TFunction<"literature">) => string | null,
  markdown?: (props: Props) => string,
): React.ComponentType<Props> {
  return function Card(props: Props): React.JSX.Element {
    const { t: translate } = useTranslation("literature");
    useCopyContent(content(props, translate), markdown?.(props));
    return <View {...props} />;
  };
}

export const Results = card(
  LiteratureResults,
  (props, translate) =>
    literatureCopy("display.literature-search", props.content, translate)
      ?.text ?? null,
);
export const Details = card(
  LiteratureDetails,
  (props, translate) =>
    literatureCopy("preview.literature-results", props.content, translate)
      ?.text ?? null,
);
export const Markdown = card(
  withCopyText(MarkdownContent),
  (props) => visibleMarkdownText(props.text),
  (props) => props.text,
);
export const Formula = card(withCopyText(FormulaView), (props) =>
  [props.source, props.caption, props.notes].filter(Boolean).join("\n"),
);
export const Tabulation = card<
  React.ComponentProps<typeof TabulationView> & { sourceMarkdown?: string }
>(
  withCopyText(TabulationView),
  (props) =>
    props.invalidSource || props.copyText
      ? [props.caption, props.invalidSource || props.copyText, props.notes]
          .filter(Boolean)
          .join("\n")
      : null,
  (props) =>
    [
      props.caption,
      props.sourceMarkdown || props.invalidSource || props.copyText,
      props.notes,
    ]
      .filter(Boolean)
      .join("\n"),
);
export const Artifact = card(ArtifactView, (props) =>
  [artifactText(props.primary), props.primaryMeta].filter(Boolean).join("\n"),
);

export function Review(
  props: React.ComponentProps<typeof LiteratureReviewCard>,
): React.JSX.Element {
  const { t: translate } = useTranslation("literature");
  useCopyContent(reviewCopy(props.content, translate)?.text ?? null);
  return <LiteratureReviewCard {...props} />;
}
