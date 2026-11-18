"use client";
import { useState, type ReactNode } from "react";
import { ImagePreview } from "@/components/ImagePreview";
import { useI18n } from "@/hooks/useI18n";
import type { WorkbenchAsset, WorkbenchFigure, WorkbenchFragment, WorkbenchReadingPassage } from "../../../packages/contracts/src/workbench";
export function Fragments({ fragments, passages, onPage }: { fragments: WorkbenchFragment[]; passages?: WorkbenchReadingPassage[]; onPage: (page: number) => void }) {
  const { t } = useI18n();
  const indices = passages?.flatMap(passage => passage.fragment_indices);
  const valid = indices?.length === fragments.length && indices.every((index, i) => index === i) && passages?.every(passage =>
    passage.fragment_indices.length > 0 && passage.joins.length === passage.fragment_indices.length - 1 && passage.joins.every((join, i) => join.before_fragment === passage.fragment_indices[i + 1]));
  const groups = valid ? passages! : fragments.map((_, index) => ({ fragment_indices: [index], joins: [] } as WorkbenchReadingPassage));
  return <div className="t1-fragments">{groups.map((passage, i) => <div className="t1-source-passage" data-passage-index={i} key={i}>
    <div className="t1-fragment-location"><div>{[...new Set(passage.fragment_indices.map(index => fragments[index].physical_page))].map(page => <button key={page} onClick={() => onPage(page)}>{t("t1.physicalPage", { page })}</button>)}</div></div>
    <p className="t1-verbatim" lang="">{passage.fragment_indices.map((index, item) => {
      const fragment = fragments[index], join = passage.joins[item - 1], previous = fragments[index - 1];
      const closeWrap = join && /(?:[-\u00ad]|\p{Script=Han})$/u.test(previous.exact_quote) && (/[-\u00ad]$/u.test(previous.exact_quote) || /^\p{Script=Han}/u.test(fragment.exact_quote));
      return <span className="t1-source-piece" key={index}>
        {join?.source_whitespace !== undefined ? <span className="t1-literal-gap">{join.source_whitespace}</span> : join && join.kind !== "offset_contiguous" ? <span className={`t1-layout-separator${closeWrap ? " t1-layout-close" : ""}`} aria-hidden="true">{"\n"}</span> : null}
        <span className="t1-source-fragment" data-fragment-index={index + 1} aria-label={t("t1.fragmentNumber", { number: index + 1 })}>{fragment.exact_quote}</span>
      </span>;
    })}</p>
  </div>)}</div>;
}
function FigureAsset({ asset, number, onPage }: { asset: WorkbenchAsset; number: string | null; onPage: (page: number) => void }) {
  const { t } = useI18n();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return <div>{failedUrl === asset.url ? <p className="t1-figure-unavailable">{t("t1.figureAssetUnavailable")}</p> : <ImagePreview src={asset.url} alt={`Figure ${number ?? "?"}`}>
    {/* Original whole-Figure assets retain their bytes and aspect ratio. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={asset.url} alt={`Figure ${number ?? "?"}`} width={asset.width} height={asset.height} loading="lazy" onError={() => setFailedUrl(asset.url)} />
  </ImagePreview>}<button className="t1-link" onClick={() => onPage(asset.page)}>{t("t1.physicalPage", { page: asset.page })}</button></div>;
}

export function FigureView({ figure, onPage, paired = false, review }: { figure: WorkbenchFigure; onPage: (page: number) => void; paired?: boolean; review?: ReactNode }) {
  const { t } = useI18n();
  return <section className="t1-figure" aria-label={`Figure ${figure.number ?? "?"}`}>
    {!paired && <p className="t1-footnote">{t("t1.independentFigure")}</p>}
    <div className="t1-section-title"><strong>Figure {figure.number ?? "?"}</strong><span>{t(figure.verification === "needs_review" ? "t1.figureNeedsReview" : "t1.figureSourceChecked")}</span></div>
    {figure.assets.map(asset => <FigureAsset key={asset.id} asset={asset} number={figure.number} onPage={onPage} />)}
    {!figure.assets.length && <p className="t1-figure-unavailable">{t("t1.figureAssetUnavailable")}{figure.caption[0]?.physical_page && <button className="t1-link" onClick={() => onPage(figure.caption[0].physical_page)}>{t("t1.openOriginal")}</button>}</p>}
    <div className="t1-caption"><span>{t("t1.caption")}</span><Fragments fragments={figure.caption} passages={figure.caption_passages} onPage={onPage} /></div>{review}
  </section>;
}
