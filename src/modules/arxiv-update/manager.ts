import PQueue from "p-queue";
import { getString } from "../../utils/locale";
import { getPref } from "../../utils/prefs";
import { arXivMerge } from "../arxiv-merge";
import { Fetcher, defaultFetcher, requestBounded } from "./fetcher";
import { PaperFinder, PaperIdentifier } from "./paper-finder";
import { UpdateStatus, UpdateTableData } from "../../types";
import { simplifyUpdateStatus, sortByStatusPriority } from "./status";

type ReportProgress = (status: UpdateStatus, msg?: string) => void;

async function translateWebURL(
  url: string,
  libraryID: number,
  collections: number[],
): Promise<Zotero.Item | false> {
  ztoolkit.log(`Trying Web Translator for ${url}`);

  const xhr = await requestBounded(url, {
    timeout: 30000,
    responseType: "document",
  });

  const finalURL = xhr.responseURL || url;

  ztoolkit.log(`Web URL resolved to ${finalURL}`);

  const doc = Zotero.HTTP.wrapDocument(xhr.response as Document, finalURL);

  const translate = new Zotero.Translate.Web();
  translate.setDocument(doc);

  const translators = await translate.getTranslators();

  if (!translators || translators.length === 0) {
    throw new Error(`No Web Translator found for ${finalURL}`);
  }

  ztoolkit.log(
    `Web Translators found for ${finalURL}: ${translators
      .map((translator: any) => translator.label || translator.translatorID)
      .join(", ")}`,
  );

  translate.setTranslator(translators);

  const items = await translate.translate({
    libraryID,
    collections,
    saveAttachments: false,
  });

  if (items.length === 0) return false;

  return items[0];
}

async function translateDOI(
  doi: string,
  libraryID: number,
  collections: number[],
): Promise<Zotero.Item | false> {
  ztoolkit.log(`Falling back to DOI Search Translator for ${doi}`);

  const translate = new Zotero.Translate.Search();

  translate.setIdentifier({ DOI: doi });

  const translators = await translate.getTranslators();

  if (!translators || translators.length === 0) {
    return false;
  }

  translate.setTranslator(translators);

  const items = await translate.translate({
    libraryID,
    collections,
    saveAttachments: false,
  });

  if (items.length === 0) return false;

  return items[0];
}

async function createItemByZotero(
  paper: PaperIdentifier,
  collections: number[],
): Promise<Zotero.Item | false> {
  const pane = Zotero.getActiveZoteroPane()!;

  const libraryID = pane.getSelectedLibraryIDs
    ? pane.getSelectedLibraryIDs()[0]
    : pane.getSelectedLibraryID();

  // ------------------------------------------------------------
  // DOI path
  //
  // Priority 1:
  // DOI -> official publisher landing page -> Web Translator
  //
  // Fallback:
  // DOI -> Zotero Search Translator
  // ------------------------------------------------------------

  if (paper.doi) {
    const doi = paper.doi
      .trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");

    const doiURL = encodeURI(`https://doi.org/${doi}`);

    ztoolkit.log(`Trying publisher Web Translator first for DOI ${doi}`);

    try {
      const item = await translateWebURL(doiURL, libraryID, collections);

      if (item) {
        ztoolkit.log(`Publisher Web Translator succeeded for DOI ${doi}`);

        return item;
      }

      ztoolkit.log(
        `Publisher Web Translator returned no items for DOI ${doi}; falling back to DOI Search`,
      );
    } catch (err) {
      // Failure here is deliberately non-fatal.
      //
      // Examples:
      // - publisher blocks automated requests
      // - DOI resolver timeout
      // - page has no Zotero Web Translator
      // - Web Translator itself fails
      //
      // In all of these cases, retain the existing DOI lookup
      // behaviour as a fallback.
      ztoolkit.log(
        `Publisher Web Translator failed for DOI ${doi}; falling back to DOI Search`,
      );
      ztoolkit.log(err);
    }

    return translateDOI(doi, libraryID, collections);
  }

  // ------------------------------------------------------------
  // Existing URL path
  // ------------------------------------------------------------

  if (paper.url) {
    return translateWebURL(paper.url, libraryID, collections);
  }

  return false;
}

/**
 * Injectable seams for UpdateManager. Production uses the defaults (the
 * bounded production fetcher and the translator-based import); tests pass
 * stubs so the whole update pipeline runs without the network.
 */
export interface UpdateManagerOptions {
  /** Network seam for the finder. Defaults to the bounded production fetcher. */
  fetcher?: Fetcher;
  /**
   * Creates the journal item from a found identifier. Defaults to
   * `createItemByZotero` (translator-based DOI/URL import).
   */
  createItem?: (
    paper: PaperIdentifier,
    collections: number[],
  ) => Promise<Zotero.Item | false>;
}

/**
 * Owns the update task queue and the row list backing the update dialog.
 * Rows are kept in display order; every mutation goes through the methods
 * here, which re-sort and notify `onChange` so the dialog can refresh.
 */
export class UpdateManager {
  unregisterObserver?: () => void;
  /** Set by the update dialog to refresh the open table on row changes. */
  onChange?: () => void;
  private tableData: UpdateTableData[] = [];
  private readonly fetcher: Fetcher;
  private readonly createItem: NonNullable<UpdateManagerOptions["createItem"]>;

  constructor(
    public queue: PQueue,
    options: UpdateManagerOptions = {},
  ) {
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.createItem = options.createItem ?? createItemByZotero;
  }

  /** The canonical row list. Read-only by convention; mutate through the methods here. */
  getRows(): UpdateTableData[] {
    return this.tableData;
  }

  createUpdateTasks(preprintItems: Zotero.Item[]) {
    for (const preprintItem of preprintItems) {
      if (
        this.tableData.findIndex((data) => data.id === preprintItem.id) == -1
      ) {
        this.tableData.push({
          id: preprintItem.id,
          title: preprintItem.getDisplayTitle(),
          status: "pending",
          message: undefined,
        });
        ztoolkit.log(
          `Enqueueing update task for "${preprintItem.getDisplayTitle()}" (queue size=${this.queue.size}, pending=${this.queue.pending})`,
        );
        this.queue.add(() =>
          this.updateItemWithProgress(preprintItem, (status, msg) =>
            this.updateRow(preprintItem.id, { status, message: msg }),
          ),
        );
      } else {
        ztoolkit.log(
          `Item "${preprintItem.getDisplayTitle()}" already in update table`,
        );
      }
    }
    this.sort();
    this.onChange?.();
  }

  /** The single row mutation path: apply a patch, keep rows sorted, notify. */
  updateRow(
    id: number,
    patch: Partial<Pick<UpdateTableData, "status" | "message">>,
  ) {
    const row = this.tableData.find((data) => data.id === id);
    if (!row) return;
    Object.assign(row, patch);
    this.sort();
    this.onChange?.();
  }

  /** Drop finished rows when the dialog is reopened. */
  filterInactive() {
    const active = this.tableData.filter((data) =>
      ["processing", "pending"].includes(simplifyUpdateStatus(data.status)),
    );
    if (active.length !== this.tableData.length) {
      this.tableData.splice(0, this.tableData.length, ...active);
      this.onChange?.();
    }
  }

  private sort() {
    const sorted = sortByStatusPriority(this.tableData);
    this.tableData.splice(0, this.tableData.length, ...sorted);
  }

  private async updateItemWithProgress(
    preprintItem: Zotero.Item,
    reportProgress: ReportProgress,
  ) {
    ztoolkit.log(`Update task started for "${preprintItem.getDisplayTitle()}"`);
    reportProgress("finding-update");
    try {
      const paper = await new PaperFinder(preprintItem, this.fetcher).find();
      if (paper === undefined) return reportProgress("up-to-date");
      // Download published version
      reportProgress("downloading-metadata");
      const pane = Zotero.getActiveZoteroPane();
      const rawCollections = pane?.getSelectedCollections
        ? pane.getSelectedCollections(true)
        : pane?.getSelectedCollection
          ? [pane.getSelectedCollection(true)]
          : [];

      const collections = (
        Array.isArray(rawCollections) ? rawCollections : []
      ).filter(
        (id): id is number => typeof id === "number" && Number.isInteger(id),
      );
      const journalItem = await this.createItem(paper, collections);
      if (!journalItem) return reportProgress("download-error");
      journalItem.saveTx();

      let hasErrorDownloadingPDF = false;
      if (
        getPref("downloadJournalPDF") &&
        Zotero.Attachments.canFindPDFForItem(journalItem)
      ) {
        reportProgress("downloading-pdf");
        const attachment = await Zotero.Attachments.addAvailableFile(
          journalItem,
          // Only download from publisher
          { methods: ["doi"] },
        );
        if (attachment) {
          attachment.setField("title", paper.title);
          attachment.saveTx();
        } else {
          hasErrorDownloadingPDF = true;
        }
      }
      await arXivMerge.merge(preprintItem, journalItem, true);

      if (hasErrorDownloadingPDF) {
        reportProgress(
          "updated",
          getString("update-message", "download-pdf-error"),
        );
      } else {
        reportProgress("updated");
      }
    } catch (err) {
      ztoolkit.log(err);
      reportProgress(
        "general-error",
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "Unknown error",
      );
    }
  }
}
