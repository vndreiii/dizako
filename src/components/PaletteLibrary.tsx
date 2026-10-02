import { useEffect, useMemo, useRef, useState } from "react";
import {
  createFolder,
  deleteFolder,
  deletePalette,
  layersFromSaved,
  movePalette,
  renameFolder,
  renamePalette,
  sameAsStack,
  savePalette,
  setFolderExpanded,
  updatePaletteColours,
  type PaletteFolder,
  type PaletteLibrary as Library,
  type SavedPalette,
} from "../dither/paletteLibrary";
import type { PaletteLayer } from "../dither/types";
import { useI18n } from "../i18n";
import { ActionMenu, SearchBar, Select, TextField, type MenuAction } from "./fields";
import {
  IconChevronRight,
  IconDelete,
  IconEdit,
  IconFolder,
  IconFolderAdd,
  IconFolderOpen,
  IconSave,
} from "./Icons";
import { useNotify } from "./notify";
import { Button, IconButton } from "./primitives";

interface Props {
  library: Library;
  update: (change: (current: Library) => Library) => void;
  replace: (library: Library) => void;
  /** The stack as it is now: what "save" stores and what a row is compared to. */
  layers: PaletteLayer[];
  /** Load a saved palette into the stack. */
  onApply: (layers: PaletteLayer[]) => void;
}

const DRAG_TYPE = "application/x-dizako-palette";
const TOP = "__top__";

/** Up to eight stripes, enough to recognise a palette at a glance. */
function Strip({ palette }: { palette: SavedPalette }) {
  return (
    <span className="plib__strip" aria-hidden="true">
      {palette.colours.slice(0, 8).map((c, i) => (
        <span key={i} style={{ background: c.hex, opacity: c.enabled ? 1 : 0.35 }} />
      ))}
    </span>
  );
}

/**
 * Saved palettes and the folders that hold them, as a list beside the studio.
 *
 * Click a palette to load it. Each row has an overflow menu (rename, update with
 * the current colours, move, delete) and can also be dragged onto a folder. A
 * deleted palette can be taken back from the toast that announces it.
 */
export function PaletteLibraryPanel({ library, update, replace, layers, onApply }: Props) {
  const { t } = useI18n();
  const notify = useNotify();
  const [saving, setSaving] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftFolder, setDraftFolder] = useState(TOP);
  const [renaming, setRenaming] = useState<{ kind: "palette" | "folder"; id: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();

  const matches = (p: SavedPalette) => !needle || p.name.toLowerCase().includes(needle);
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });

  const rootPalettes = useMemo(
    () => library.palettes.filter((p) => p.folderId === null && matches(p)).sort(byName),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `matches` depends only on `needle`
    [library.palettes, needle],
  );
  const folders = useMemo(
    () =>
      [...library.folders].sort(byName).map((folder) => ({
        folder,
        palettes: library.palettes.filter((p) => p.folderId === folder.id && matches(p)).sort(byName),
        total: library.palettes.filter((p) => p.folderId === folder.id).length,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as above
    [library.folders, library.palettes, needle],
  );
  const visibleFolders = needle ? folders.filter((f) => f.palettes.length > 0) : folders;
  const empty = library.palettes.length === 0 && library.folders.length === 0;
  const nothingFound = needle && rootPalettes.length === 0 && visibleFolders.length === 0;

  const startSave = () => {
    setDraftName(t("library.defaultName"));
    setDraftFolder(TOP);
    setSaving(true);
  };

  const commitSave = () => {
    update((lib) =>
      savePalette(lib, { name: draftName, layers, folderId: draftFolder === TOP ? null : draftFolder }).library,
    );
    // Show where it landed.
    if (draftFolder !== TOP) update((lib) => setFolderExpanded(lib, draftFolder, true));
    setSaving(false);
    notify.toast(t("library.saved"), { tone: "success" });
  };

  const addFolder = () => {
    // Built from the value on screen rather than inside an updater: the id is
    // needed right away to drop the new folder into rename mode.
    const made = createFolder(library, t("library.defaultFolder"));
    replace(made.library);
    setRenaming({ kind: "folder", id: made.id });
  };

  const removePalette = (p: SavedPalette) => {
    const before = library;
    update((lib) => deletePalette(lib, p.id));
    notify.toast(t("library.deleted").replace("{name}", p.name), {
      action: { label: t("library.undo"), onClick: () => replace(before) },
    });
  };

  const removeFolder = async (folder: PaletteFolder, count: number) => {
    if (count === 0) {
      update((lib) => deleteFolder(lib, folder.id, true));
      return;
    }
    const answer = await notify.dialog({
      title: t("library.deleteFolderTitle").replace("{name}", folder.name),
      body: t("library.deleteFolderBody").replace("{n}", String(count)),
      tone: "warning",
      buttons: [
        { label: t("picker.cancel"), value: "cancel", variant: "text" },
        { label: t("library.keepPalettes"), value: "keep", variant: "tonal" },
        { label: t("library.deleteAll"), value: "delete", variant: "filled" },
      ],
      dismissValue: "cancel",
    });
    if (answer === "keep") update((lib) => deleteFolder(lib, folder.id, true));
    else if (answer === "delete") {
      const before = library;
      update((lib) => deleteFolder(lib, folder.id, false));
      notify.toast(t("library.deleted").replace("{name}", folder.name), {
        action: { label: t("library.undo"), onClick: () => replace(before) },
      });
    }
  };

  const paletteActions = (p: SavedPalette): MenuAction[] => [
    { id: "apply", label: t("library.apply"), icon: <IconFolderOpen />, onSelect: () => onApply(layersFromSaved(p)) },
    { id: "rename", label: t("library.rename"), icon: <IconEdit />, onSelect: () => setRenaming({ kind: "palette", id: p.id }) },
    {
      id: "update",
      label: t("library.updateWithCurrent"),
      icon: <IconSave />,
      disabled: sameAsStack(p, layers),
      onSelect: () => update((lib) => updatePaletteColours(lib, p.id, layers)),
    },
    {
      id: "top",
      heading: t("library.moveTo"),
      divider: true,
      label: t("library.topLevel"),
      checked: p.folderId === null,
      onSelect: () => update((lib) => movePalette(lib, p.id, null)),
    },
    ...library.folders
      .slice()
      .sort(byName)
      .map((f) => ({
        id: `to-${f.id}`,
        label: f.name,
        checked: p.folderId === f.id,
        onSelect: () => update((lib) => movePalette(lib, p.id, f.id)),
      })),
    { id: "delete", label: t("library.delete"), icon: <IconDelete />, danger: true, divider: true, onSelect: () => removePalette(p) },
  ];

  const folderActions = (f: PaletteFolder, total: number): MenuAction[] => [
    { id: "rename", label: t("library.rename"), icon: <IconEdit />, onSelect: () => setRenaming({ kind: "folder", id: f.id }) },
    { id: "delete", label: t("library.deleteFolder"), icon: <IconDelete />, danger: true, divider: true, onSelect: () => void removeFolder(f, total) },
  ];

  const renameRow = (name: string, kind: "palette" | "folder", id: string) => (
    <RenameField
      initial={name}
      label={t("library.name")}
      onCommit={(value) => {
        setRenaming(null);
        if (!value.trim()) return;
        update((lib) => (kind === "palette" ? renamePalette(lib, id, value) : renameFolder(lib, id, value)));
      }}
      onCancel={() => setRenaming(null)}
    />
  );

  const paletteRow = (p: SavedPalette) => {
    const active = sameAsStack(p, layers);
    return (
      <li
        key={p.id}
        className={`plib__row ${active ? "is-active" : ""}`}
        draggable={renaming?.id !== p.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, p.id);
          e.dataTransfer.effectAllowed = "move";
        }}
      >
        {renaming?.kind === "palette" && renaming.id === p.id ? (
          renameRow(p.name, "palette", p.id)
        ) : (
          <>
            <button className="plib__item" onClick={() => onApply(layersFromSaved(p))} title={t("library.apply")}>
              <Strip palette={p} />
              <span className="plib__name">{p.name}</span>
              <span className="plib__count">{p.colours.length}</span>
            </button>
            <ActionMenu label={t("library.moreFor").replace("{name}", p.name)} actions={paletteActions(p)} />
          </>
        )}
      </li>
    );
  };

  return (
    <section
      className={`plib ${dropTarget === TOP ? "is-drop" : ""}`}
      aria-label={t("library.title")}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_TYPE)) {
          e.preventDefault();
          setDropTarget((cur) => cur ?? TOP);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(DRAG_TYPE);
        setDropTarget(null);
        if (id) {
          e.preventDefault();
          update((lib) => movePalette(lib, id, null));
        }
      }}
    >
      <header className="plib__head">
        <h2 className="plib__title">{t("library.title")}</h2>
        <span className="plib__spacer" />
        <IconButton label={t("library.newFolder")} onClick={addFolder}>
          <IconFolderAdd />
        </IconButton>
        <IconButton label={t("library.saveCurrent")} variant="tonal" onClick={startSave}>
          <IconSave />
        </IconButton>
      </header>

      {saving && (
        <form
          className="plib__save"
          onSubmit={(e) => {
            e.preventDefault();
            commitSave();
          }}
        >
          <TextField label={t("library.name")} value={draftName} onChange={setDraftName} />
          <Select
            label={t("library.saveIn")}
            value={draftFolder}
            onChange={setDraftFolder}
            options={[
              { value: TOP, label: t("library.topLevel") },
              ...library.folders.slice().sort(byName).map((f) => ({ value: f.id, label: f.name })),
            ]}
          />
          <div className="plib__saveactions">
            <Button type="button" variant="text" onClick={() => setSaving(false)}>
              {t("picker.cancel")}
            </Button>
            <Button type="submit" variant="filled" icon={<IconSave />} disabled={!draftName.trim()}>
              {t("library.save")}
            </Button>
          </div>
        </form>
      )}

      {!empty && (
        <div className="plib__search">
          <SearchBar value={query} onChange={setQuery} placeholder={t("library.search")} clearLabel={t("common.clearSearch")} />
        </div>
      )}

      <div className="plib__scroll">
        {empty && !saving && <p className="plib__empty">{t("library.empty")}</p>}
        {nothingFound && <p className="plib__empty">{t("common.noMatches").replace("{q}", query.trim())}</p>}

        <ul className="plib__list">
          {visibleFolders.map(({ folder, palettes, total }) => {
            const open = needle ? true : folder.expanded;
            return (
              <li key={folder.id} className="plib__folderwrap">
                <div
                  className={`plib__folder ${dropTarget === folder.id ? "is-drop" : ""}`}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(DRAG_TYPE)) {
                      e.preventDefault();
                      e.stopPropagation();
                      setDropTarget(folder.id);
                    }
                  }}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData(DRAG_TYPE);
                    setDropTarget(null);
                    if (id) {
                      e.preventDefault();
                      e.stopPropagation();
                      update((lib) => setFolderExpanded(movePalette(lib, id, folder.id), folder.id, true));
                    }
                  }}
                >
                  {renaming?.kind === "folder" && renaming.id === folder.id ? (
                    renameRow(folder.name, "folder", folder.id)
                  ) : (
                    <>
                      <button
                        className="plib__foldertoggle"
                        aria-expanded={open}
                        onClick={() => update((lib) => setFolderExpanded(lib, folder.id, !folder.expanded))}
                      >
                        <span className={`plib__chev ${open ? "is-open" : ""}`} aria-hidden="true">
                          <IconChevronRight />
                        </span>
                        <span className="plib__foldericon" aria-hidden="true">
                          {open ? <IconFolderOpen /> : <IconFolder />}
                        </span>
                        <span className="plib__name">{folder.name}</span>
                        <span className="plib__count">{total}</span>
                      </button>
                      <ActionMenu label={t("library.moreFor").replace("{name}", folder.name)} actions={folderActions(folder, total)} />
                    </>
                  )}
                </div>
                {open && (
                  <ul className="plib__nested">
                    {palettes.length === 0 ? (
                      <li className="plib__hint">{t("library.folderEmpty")}</li>
                    ) : (
                      palettes.map(paletteRow)
                    )}
                  </ul>
                )}
              </li>
            );
          })}
          {rootPalettes.map(paletteRow)}
        </ul>
      </div>
    </section>
  );
}

/** An inline text field for renaming a row: Enter or leaving commits, Escape cancels. */
function RenameField({
  initial,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };

  return (
    <input
      ref={ref}
      className="plib__rename"
      value={value}
      aria-label={label}
      maxLength={80}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}

