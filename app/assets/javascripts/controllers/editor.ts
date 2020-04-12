import { WebApplication } from './../application';
import { PanelPuppet, WebDirective } from './../types';
import angular from 'angular';
import {
  ApplicationEvent,
  isPayloadSourceRetrieved,
  ContentType,
  ProtectedAction,
  SNComponent,
  SNNote,
  SNTag,
  NoteMutator,
  Uuids,
  ComponentArea,
  ComponentAction,
  PayloadSource
} from 'snjs';
import find from 'lodash/find';
import { isDesktopApplication } from '@/utils';
import { KeyboardModifier, KeyboardKey } from '@/services/keyboardManager';
import template from '%/editor.pug';
import { PureCtrl } from '@Controllers/abstract/pure_ctrl';
import { AppStateEvent, EventSource } from '@/services/state';
import {
  STRING_DELETED_NOTE,
  STRING_INVALID_NOTE,
  STRING_ELLIPSES,
  STRING_DELETE_PLACEHOLDER_ATTEMPT,
  STRING_DELETE_LOCKED_ATTEMPT,
  StringDeleteNote,
  StringEmptyTrash
} from '@/strings';
import { PrefKeys } from '@/services/preferencesManager';
import { RawPayload } from '@/../../../../snjs/dist/@types/protocol/payloads/generator';
import { ComponentMutator } from '@/../../../../snjs/dist/@types/models';

const NOTE_PREVIEW_CHAR_LIMIT = 80;
const MINIMUM_STATUS_DURATION = 400;
const SAVE_TIMEOUT_DEBOUNCE = 350;
const SAVE_TIMEOUT_NO_DEBOUNCE = 100;
const EDITOR_DEBOUNCE = 200;

const AppDataKeys = {
  Pinned: 'pinned',
  Locked: 'locked',
  Archived: 'archived',
  PrefersPlainEditor: 'prefersPlainEditor'
};
const ElementIds = {
  NoteTextEditor: 'note-text-editor',
  NoteTitleEditor: 'note-title-editor',
  EditorContent: 'editor-content',
  NoteTagsComponentContainer: 'note-tags-component-container'
};
const Fonts = {
  DesktopMonospaceFamily: `Menlo,Consolas,'DejaVu Sans Mono',monospace`,
  WebMonospaceFamily: `monospace`,
  SansSerifFamily: `inherit`
};

type NoteStatus = {
  message?: string
  date?: Date
}

type EditorState = {
  note: SNNote
  saveError?: any
  selectedEditor?: SNComponent
  noteStatus?: NoteStatus
  tagsAsStrings?: string
  marginResizersEnabled?: boolean
  monospaceEnabled?: boolean
  isDesktop?: boolean
  tagsComponent?: SNComponent
  componentStack?: SNComponent[]
  /** Fields that can be directly mutated by the template */
  mutable: { }
}

type EditorValues = {
  title?: string
  text?: string
  tagsInputValue?: string
}

class EditorCtrl extends PureCtrl {
  /** Passed through template */
  readonly application!: WebApplication
  private leftPanelPuppet?: PanelPuppet
  private rightPanelPuppet?: PanelPuppet
  private unregisterComponent: any
  private saveTimeout?: ng.IPromise<void>
  private statusTimeout?: ng.IPromise<void>
  private lastEditorFocusEventSource?: EventSource
  public editorValues: EditorValues = {}
  onEditorLoad?: () => void

  private removeAltKeyObserver?: any
  private removeTrashKeyObserver?: any
  private removeDeleteKeyObserver?: any
  private removeTabObserver?: any

  prefKeyMonospace: string
  prefKeySpellcheck: string
  prefKeyMarginResizers: string

  /* @ngInject */
  constructor($timeout: ng.ITimeoutService) {
    super($timeout);
    this.leftPanelPuppet = {
      onReady: () => this.reloadPreferences()
    };
    this.rightPanelPuppet = {
      onReady: () => this.reloadPreferences()
    };
    /** Used by .pug template */
    this.prefKeyMonospace = PrefKeys.EditorMonospaceEnabled;
    this.prefKeySpellcheck = PrefKeys.EditorSpellcheck;
    this.prefKeyMarginResizers = PrefKeys.EditorResizersEnabled;

    this.editorMenuOnSelect = this.editorMenuOnSelect.bind(this);
    this.onPanelResizeFinish = this.onPanelResizeFinish.bind(this);
    this.onEditorLoad = () => {
      this.application!.getDesktopService().redoSearch();
    }
  }

  deinit() {
    this.removeAltKeyObserver();
    this.removeAltKeyObserver = undefined;
    this.removeTrashKeyObserver();
    this.removeTrashKeyObserver = undefined;
    this.removeDeleteKeyObserver();
    this.removeDeleteKeyObserver = undefined;
    this.removeTabObserver && this.removeTabObserver();
    this.removeTabObserver = undefined;
    this.leftPanelPuppet = undefined;
    this.rightPanelPuppet = undefined;
    this.onEditorLoad = undefined;
    this.unregisterComponent();
    this.unregisterComponent = undefined;
    this.saveTimeout = undefined;
    this.statusTimeout = undefined;
    (this.onPanelResizeFinish as any) = undefined;
    (this.editorMenuOnSelect as any) = undefined;
    super.deinit();
  }

  getState() {
    return this.state as EditorState;
  }

  $onInit() {
    super.$onInit();
    this.registerKeyboardShortcuts();
  }

  /** @override */
  getInitialState() {
    return {
      componentStack: [],
      editorDebounce: EDITOR_DEBOUNCE,
      isDesktop: isDesktopApplication(),
      spellcheck: true,
      mutable: {
        tagsString: ''
      }
    };
  }

  async onAppLaunch() {
    await super.onAppLaunch();
    this.streamItems();
    this.registerComponentHandler();
  }

  /** @override */
  onAppStateEvent(eventName: AppStateEvent, data: any) {
    if (eventName === AppStateEvent.NoteChanged) {
      this.handleNoteSelectionChange(
        this.application.getAppState().getSelectedNote()!,
        data.previousNote
      );
    } else if (eventName === AppStateEvent.PreferencesChanged) {
      this.reloadPreferences();
    }
  }

  /** @override */
  onAppEvent(eventName: ApplicationEvent) {
    if (!this.getState().note) {
      return;
    }
    if (eventName === ApplicationEvent.HighLatencySync) {
      this.setState({ syncTakingTooLong: true });
    } else if (eventName === ApplicationEvent.CompletedSync) {
      this.setState({ syncTakingTooLong: false });
      if (this.getState().note.dirty) {
        /** if we're still dirty, don't change status, a sync is likely upcoming. */
      } else {
        const saved = this.getState().note.lastSyncEnd! > this.getState().note.lastSyncBegan!;
        const isInErrorState = this.getState().saveError;
        if (isInErrorState || saved) {
          this.showAllChangesSavedStatus();
        }
      }
    } else if (eventName === ApplicationEvent.FailedSync) {
      /**
       * Only show error status in editor if the note is dirty.
       * Otherwise, it means the originating sync came from somewhere else
       * and we don't want to display an error here.
       */
      if (this.getState().note.dirty) {
        this.showErrorStatus();
      }
    } else if (eventName === ApplicationEvent.LocalDatabaseWriteError) {
      this.showErrorStatus({
        message: "Offline Saving Issue",
        desc: "Changes not saved"
      });
    }
  }

  /**
   * Because note.locked accesses note.content.appData,
   * we do not want to expose the template to direct access to note.locked,
   * otherwise an exception will occur when trying to access note.locked if the note 
   * is deleted. There is potential for race conditions to occur with setState, where a
   * previous setState call may have queued a digest cycle, and the digest cycle triggers
   * on a deleted note.
   */
  get noteLocked() {
    if (!this.getState().note || this.getState().note.deleted) {
      return false;
    }
    return this.getState().note.locked;
  }

  streamItems() {
    this.application.streamItems(
      ContentType.Note,
      async (items, source) => {
        const currentNote = this.getState().note;
        if (!currentNote) {
          return;
        }
        if (currentNote.deleted) {
          await this.setState({
            note: null,
            noteReady: false
          });
          return;
        }
        if (!isPayloadSourceRetrieved(source!)) {
          return;
        }
        const matchingNote = items.find((item) => {
          return item.uuid === currentNote.uuid;
        }) as SNNote;
        if (!matchingNote) {
          return;
        }
        this.editorValues.title = matchingNote.title;
        this.editorValues.text = matchingNote.text;
        this.reloadTagsString();
      }
    );

    this.application.streamItems(
      ContentType.Tag,
      (items) => {
        if (!this.getState().note) {
          return;
        }
        for (const tag of items) {
          if (
            !this.editorValues.tagsInputValue ||
            tag.deleted ||
            tag.hasRelationshipWithItem(this.getState().note)
          ) {
            this.reloadTagsString();
            break;
          }
        }
      }
    );

    this.application.streamItems(
      ContentType.Component,
      async (items) => {
        const components = items as SNComponent[];
        if (!this.getState().note) {
          return;
        }
        /** Reload componentStack in case new ones were added or removed */
        this.reloadComponentStackArray();
        /** Observe editor changes to see if the current note should update its editor */
        const editors = components.filter((component) => {
          return component.isEditor();
        });
        if (editors.length === 0) {
          return;
        }
        /** Find the most recent editor for note */
        const editor = this.editorForNote(this.getState().note);
        this.setState({
          selectedEditor: editor
        });
        if (!editor) {
          this.reloadFont();
        }
      }
    );
  }

  async handleNoteSelectionChange(note: SNNote, previousNote?: SNNote) {
    this.setState({
      note: this.application.getAppState().getSelectedNote(),
      showExtensions: false,
      showOptionsMenu: false,
      altKeyDown: false,
      noteStatus: null
    });
    if (!note) {
      this.setState({
        noteReady: false
      });
      return;
    }
    const associatedEditor = this.editorForNote(note);
    if (associatedEditor && associatedEditor !== this.getState().selectedEditor) {
      /**
       * Setting note to not ready will remove the editor from view in a flash,
       * so we only want to do this if switching between external editors
       */
      this.setState({
        noteReady: false,
        selectedEditor: associatedEditor
      });
    } else if (!associatedEditor) {
      /** No editor */
      this.setState({
        selectedEditor: null
      });
    }
    await this.setState({
      noteReady: true,
    });
    this.reloadTagsString();
    this.reloadPreferences();

    if (note.dummy) {
      this.focusTitle();
    }
    if (previousNote && previousNote !== note) {
      if (previousNote.dummy) {
        this.performNoteDeletion(previousNote);
      }
    }

    this.reloadComponentContext();
  }

  editorForNote(note: SNNote) {
    return this.application.componentManager!.editorForNote(note);
  }

  setMenuState(menu: string, state: boolean) {
    this.setState({
      [menu]: state
    });
    this.closeAllMenus(menu);
  }

  toggleMenu(menu: string) {
    this.setMenuState(menu, !this.state[menu]);
  }

  closeAllMenus(exclude?: string) {
    const allMenus = [
      'showOptionsMenu',
      'showEditorMenu',
      'showExtensions',
      'showSessionHistory'
    ];
    const menuState: any = {};
    for (const candidate of allMenus) {
      if (candidate !== exclude) {
        menuState[candidate] = false;
      }
    }
    this.setState(menuState);
  }

  editorMenuOnSelect(component: SNComponent) {
    if (!component || component.area === 'editor-editor') {
      /** If plain editor or other editor */
      this.setMenuState('showEditorMenu', false);
      const editor = component;
      if (this.getState().selectedEditor && editor !== this.getState().selectedEditor) {
        this.disassociateComponentWithCurrentNote(this.getState().selectedEditor!);
      }
      const note = this.getState().note;
      if (editor) {
        const prefersPlain = note.prefersPlainEditor;
        if (prefersPlain) {
          this.application.changeItem(note.uuid, (mutator) => {
            const noteMutator = mutator as NoteMutator;
            noteMutator.prefersPlainEditor = false;
          })
        }
        this.associateComponentWithCurrentNote(editor);
      } else {
        /** Note prefers plain editor */
        if (!note.prefersPlainEditor) {
          this.application.changeItem(note.uuid, (mutator) => {
            const noteMutator = mutator as NoteMutator;
            noteMutator.prefersPlainEditor = true;
          })
        }
        this.reloadFont();
      }

      this.setState({
        selectedEditor: editor
      });
    } else if (component.area === 'editor-stack') {
      this.toggleStackComponentForCurrentItem(component);
    }

    /** Dirtying can happen above */
    this.application.sync();
  }

  hasAvailableExtensions() {
    return this.application.actionsManager!.
      extensionsInContextOfItem(this.getState().note).length > 0;
  }

  performFirefoxPinnedTabFix() {
    /**
     * For Firefox pinned tab issue:
     * When a new browser session is started, and SN is in a pinned tab,
     * SN is unusable until the tab is reloaded.
     */
    if (document.hidden) {
      window.location.reload();
    }
  }

  saveNote(
    bypassDebouncer = false,
    isUserModified = false,
    dontUpdatePreviews = false,
    customMutate?: (mutator: NoteMutator) => void
  ) {
    this.performFirefoxPinnedTabFix();
    const note = this.getState().note;

    if (note.deleted) {
      this.application.alertService!.alert(
        STRING_DELETED_NOTE
      );
      return;
    }
    if (!this.application.findItem(note.uuid)) {
      this.application.alertService!.alert(
        STRING_INVALID_NOTE
      );
      return;
    }

    this.showSavingStatus();

    this.application.changeItem(note.uuid, (mutator) => {
      const noteMutator = mutator as NoteMutator;
      if (customMutate) {
        customMutate(noteMutator);
      }
      noteMutator.title = this.editorValues.title!;
      noteMutator.text = this.editorValues.text!;
      if (!dontUpdatePreviews) {
        const text = note.text || '';
        const truncate = text.length > NOTE_PREVIEW_CHAR_LIMIT;
        const substring = text.substring(0, NOTE_PREVIEW_CHAR_LIMIT);
        const previewPlain = substring + (truncate ? STRING_ELLIPSES : '');
        noteMutator.preview_plain = previewPlain;
        noteMutator.preview_html = undefined;
      }
    }, isUserModified)

    if (this.saveTimeout) {
      this.$timeout.cancel(this.saveTimeout);
    }

    const noDebounce = bypassDebouncer || this.application.noAccount();
    const syncDebouceMs = noDebounce
      ? SAVE_TIMEOUT_NO_DEBOUNCE
      : SAVE_TIMEOUT_DEBOUNCE;
    this.saveTimeout = this.$timeout(() => {
      this.application.sync();
    }, syncDebouceMs);
  }

  showSavingStatus() {
    this.setStatus(
      { message: "Saving..." },
      false
    );
  }

  showAllChangesSavedStatus() {
    this.setState({
      saveError: false,
      syncTakingTooLong: false
    });
    this.setStatus({
      message: 'All changes saved',
    });
  }

  showErrorStatus(error?: any) {
    if (!error) {
      error = {
        message: "Sync Unreachable",
        desc: "Changes saved offline"
      };
    }
    this.setState({
      saveError: true,
      syncTakingTooLong: false
    });
    this.setStatus(error);
  }

  setStatus(status: { message: string, date?: Date }, wait = true) {
    let waitForMs;
    if (!this.getState().noteStatus || !this.getState().noteStatus!.date) {
      waitForMs = 0;
    } else {
      waitForMs = MINIMUM_STATUS_DURATION - (
        new Date().getTime() - this.getState().noteStatus!.date!.getTime()
      );
    }
    if (!wait || waitForMs < 0) {
      waitForMs = 0;
    }
    if (this.statusTimeout) {
      this.$timeout.cancel(this.statusTimeout);
    }
    this.statusTimeout = this.$timeout(() => {
      status.date = new Date();
      this.setState({
        noteStatus: status
      });
    }, waitForMs);
  }

  contentChanged() {
    this.saveNote(
      false,
      true
    );
  }

  onTitleEnter($event: Event) {
    ($event.target as HTMLInputElement).blur();
    this.onTitleChange();
    this.focusEditor();
  }

  onTitleChange() {
    this.saveNote(
      false,
      true,
      true,
    );
  }

  focusEditor() {
    const element = document.getElementById(ElementIds.NoteTextEditor);
    if (element) {
      this.lastEditorFocusEventSource = EventSource.Script;
      element.focus();
    }
  }

  focusTitle() {
    document.getElementById(ElementIds.NoteTitleEditor)!.focus();
  }

  clickedTextArea() {
    this.setMenuState('showOptionsMenu', false);
  }

  onTitleFocus() {

  }

  onTitleBlur() {

  }

  onContentFocus() {
    this.application.getAppState().editorDidFocus(this.lastEditorFocusEventSource!);
    this.lastEditorFocusEventSource = undefined;
  }

  selectedMenuItem(hide: boolean) {
    if (hide) {
      this.setMenuState('showOptionsMenu', false);
    }
  }

  async deleteNote(permanently: boolean) {
    if (this.getState().note.dummy) {
      this.application.alertService!.alert(
        STRING_DELETE_PLACEHOLDER_ATTEMPT
      );
      return;
    }
    const run = () => {
      if (this.getState().note.locked) {
        this.application.alertService!.alert(
          STRING_DELETE_LOCKED_ATTEMPT
        );
        return;
      }
      const title = this.getState().note.safeTitle().length
        ? `'${this.getState().note.title}'`
        : "this note";
      const text = StringDeleteNote(
        title,
        permanently
      );
      this.application.alertService!.confirm(
        text,
        undefined,
        undefined,
        undefined,
        () => {
          if (permanently) {
            this.performNoteDeletion(this.getState().note);
          } else {
            this.saveNote(
              true,
              false,
              true,
              (mutator) => {
                mutator.trashed = true;
              }
            );
          }
          this.application.getAppState().setSelectedNote(undefined);
          this.setMenuState('showOptionsMenu', false);
        },
        undefined,
        true,
      );
    };
    const requiresPrivilege = await this.application.privilegesService!.actionRequiresPrivilege(
      ProtectedAction.DeleteNote
    );
    if (requiresPrivilege) {
      this.application.presentPrivilegesModal(
        ProtectedAction.DeleteNote,
        () => {
          run();
        }
      );
    } else {
      run();
    }
  }

  performNoteDeletion(note: SNNote) {
    this.application.deleteItem(note);
    if (note === this.getState().note) {
      this.setState({
        note: null
      });
    }
    if (note.dummy) {
      this.application.deleteItemLocally(note);
      return;
    }
    this.application.sync();
  }

  restoreTrashedNote() {
    this.saveNote(
      true,
      false,
      true,
      (mutator) => {
        mutator.trashed = false;
      }
    );
    this.application.getAppState().setSelectedNote(undefined);
  }

  deleteNotePermanantely() {
    this.deleteNote(true);
  }

  getTrashCount() {
    return this.application.getTrashedItems().length;
  }

  emptyTrash() {
    const count = this.getTrashCount();
    this.application.alertService!.confirm(
      StringEmptyTrash(count),
      undefined,
      undefined,
      undefined,
      () => {
        this.application.emptyTrash();
        this.application.sync();
      },
      undefined,
      true,
    );
  }

  togglePin() {
    this.saveNote(
      true,
      false,
      true,
      (mutator) => {
        mutator.pinned = !this.getState().note.pinned
      }
    );
  }

  toggleLockNote() {
    this.saveNote(
      true,
      false,
      true,
      (mutator) => {
        mutator.locked = !this.getState().note.locked
      }
    );
  }

  toggleProtectNote() {
    this.saveNote(
      true,
      false,
      true,
      (mutator) => {
        mutator.protected = !this.getState().note.protected
      }
    );
    /** Show privileges manager if protection is not yet set up */
    this.application.privilegesService!.actionHasPrivilegesConfigured(
      ProtectedAction.ViewProtectedNotes
    ).then((configured) => {
      if (!configured) {
        this.application.presentPrivilegesManagementModal();
      }
    });
  }

  toggleNotePreview() {
    this.saveNote(
      true,
      false,
      true,
      (mutator) => {
        mutator.hidePreview = !this.getState().note.hidePreview
      }
    );
  }

  toggleArchiveNote() {
    this.saveNote(
      true,
      false,
      true,
      (mutator) => {
        mutator.archived = !this.getState().note.archived
      }
    );
  }

  reloadTagsString() {
    const tags = this.appState.getNoteTags(this.getState().note);
    const string = SNTag.arrayToDisplayString(tags);
    this.updateUI(() => {
      this.editorValues.tagsInputValue = string;
    })
  }

  addTag(tag: SNTag) {
    const tags = this.appState.getNoteTags(this.getState().note);
    const strings = tags.map((currentTag) => {
      return currentTag.title;
    });
    strings.push(tag.title);
    this.saveTagsFromStrings(strings);
  }

  removeTag(tag: SNTag) {
    const tags = this.appState.getNoteTags(this.getState().note);
    const strings = tags.map((currentTag) => {
      return currentTag.title;
    }).filter((title) => {
      return title !== tag.title;
    });
    this.saveTagsFromStrings(strings);
  }

  async saveTagsFromStrings(strings?: string[]) {
    if (
      !strings
      && this.editorValues.tagsInputValue === this.getState().tagsAsStrings
    ) {
      return;
    }
    if (!strings) {
      strings = this.editorValues.tagsInputValue!
        .split('#')
        .filter((string) => {
          return string.length > 0;
        })
        .map((string) => {
          return string.trim();
        });
    }

    const note = this.getState().note;
    const currentTags = this.appState.getNoteTags(note);

    const removeTags = [];
    for (const tag of currentTags) {
      if (strings.indexOf(tag.title) === -1) {
        removeTags.push(tag);
      }
    }
    for (const tag of removeTags) {
      this.application.changeItem(tag.uuid, (mutator) => {
        mutator.removeItemAsRelationship(note);
      })
    }
    const newRelationships: SNTag[] = [];
    for (const title of strings) {
      const existingRelationship = find(
        currentTags,
        { title: title }
      );
      if (!existingRelationship) {
        newRelationships.push(
          await this.application.findOrCreateTag(title)
        );
      }
    }
    this.application.changeAndSaveItems(Uuids(newRelationships), (mutator) => {
      mutator.addItemAsRelationship(note);
    })
    this.reloadTagsString();
  }

  onPanelResizeFinish(width: number, left: number, isMaxWidth: boolean) {
    if (isMaxWidth) {
      this.application.getPrefsService().setUserPrefValue(
        PrefKeys.EditorWidth,
        null
      );
    } else {
      if (width !== undefined && width !== null) {
        this.application.getPrefsService().setUserPrefValue(
          PrefKeys.EditorWidth,
          width
        );
        this.leftPanelPuppet!.setWidth!(width);
      }
    }
    if (left !== undefined && left !== null) {
      this.application.getPrefsService().setUserPrefValue(
        PrefKeys.EditorLeft,
        left
      );
      this.rightPanelPuppet!.setLeft!(left);
    }
    this.application.getPrefsService().syncUserPreferences();
  }

  reloadPreferences() {
    const monospaceEnabled = this.application.getPrefsService().getValue(
      PrefKeys.EditorMonospaceEnabled,
      true
    );
    const spellcheck = this.application.getPrefsService().getValue(
      PrefKeys.EditorSpellcheck,
      true
    );
    const marginResizersEnabled = this.application.getPrefsService().getValue(
      PrefKeys.EditorResizersEnabled,
      true
    );
    this.setState({
      monospaceEnabled,
      spellcheck,
      marginResizersEnabled
    });

    if (!document.getElementById(ElementIds.EditorContent)) {
      /** Elements have not yet loaded due to ng-if around wrapper */
      return;
    }

    this.reloadFont();

    if (
      this.getState().marginResizersEnabled &&
      this.leftPanelPuppet!.ready &&
      this.rightPanelPuppet!.ready
    ) {
      const width = this.application.getPrefsService().getValue(
        PrefKeys.EditorWidth,
        null
      );
      if (width != null) {
        this.leftPanelPuppet!.setWidth!(width);
        this.rightPanelPuppet!.setWidth!(width);
      }
      const left = this.application.getPrefsService().getValue(
        PrefKeys.EditorLeft,
        null
      );
      if (left != null) {
        this.leftPanelPuppet!.setLeft!(left);
        this.rightPanelPuppet!.setLeft!(left);
      }
    }
  }

  reloadFont() {
    const editor = document.getElementById(
      ElementIds.NoteTextEditor
    );
    if (!editor) {
      return;
    }
    if (this.getState().monospaceEnabled) {
      if (this.getState().isDesktop) {
        editor.style.fontFamily = Fonts.DesktopMonospaceFamily;
      } else {
        editor.style.fontFamily = Fonts.WebMonospaceFamily;
      }
    } else {
      editor.style.fontFamily = Fonts.SansSerifFamily;
    }
  }

  async togglePrefKey(key: string) {
    (this as any)[key] = !(this as any)[key];
    this.application.getPrefsService().setUserPrefValue(
      key,
      (this as any)[key],
      true
    );
    this.reloadFont();

    if (key === PrefKeys.EditorSpellcheck) {
      /** Allows textarea to reload */
      await this.setState({
        noteReady: false
      });
      this.setState({
        noteReady: true
      });
      this.reloadFont();
    } else if (key === PrefKeys.EditorResizersEnabled && (this as any)[key] === true) {
      this.$timeout(() => {
        this.leftPanelPuppet!.flash!();
        this.rightPanelPuppet!.flash!();
      });
    }
  }

  /** @components */

  registerComponentHandler() {
    this.unregisterComponent = this.application.componentManager!.registerHandler({
      identifier: 'editor',
      areas: [
        ComponentArea.NoteTags,
        ComponentArea.EditorStack,
        ComponentArea.Editor
      ],
      activationHandler: (component) => {
        if (component.area === 'note-tags') {
          this.setState({
            tagsComponent: component.active ? component : null
          });
        } else if (component.area === 'editor-editor') {
          if (
            component === this.getState().selectedEditor &&
            !component.active
          ) {
            this.setState({ selectedEditor: null });
          }
          else if (this.getState().selectedEditor) {
            if (this.getState().selectedEditor!.active && this.getState().note) {
              if (
                component.isExplicitlyEnabledForItem(this.getState().note)
                && !this.getState().selectedEditor!.isExplicitlyEnabledForItem(this.getState().note)
              ) {
                this.setState({ selectedEditor: component });
              }
            }
          }
          else if (this.getState().note) {
            const enableable = (
              component.isExplicitlyEnabledForItem(this.getState().note)
              || component.isDefaultEditor()
            );
            if (
              component.active
              && enableable
            ) {
              this.setState({ selectedEditor: component });
            } else {
              /**
               * Not a candidate, and no qualified editor.
               * Disable the current editor.
               */
              this.setState({ selectedEditor: null });
            }
          }

        } else if (component.area === 'editor-stack') {
          this.reloadComponentContext();
        }
      },
      contextRequestHandler: (component) => {
        if (
          component === this.getState().selectedEditor ||
          component === this.getState().tagsComponent ||
          this.getState().componentStack!.includes(component)
        ) {
          return this.getState().note;
        }
      },
      focusHandler: (component, focused) => {
        if (component.isEditor() && focused) {
          this.closeAllMenus();
        }
      },
      actionHandler: (component, action, data) => {
        if (action === ComponentAction.SetSize) {
          const setSize = function (element: HTMLElement, size: { width: number, height: number }) {
            const widthString = typeof size.width === 'string'
              ? size.width
              : `${data.width}px`;
            const heightString = typeof size.height === 'string'
              ? size.height
              : `${data.height}px`;
            element.setAttribute(
              'style',
              `width: ${widthString}; height: ${heightString};`
            );
          };
          if (data.type === 'container') {
            if (component.area === ComponentArea.NoteTags) {
              const container = document.getElementById(
                ElementIds.NoteTagsComponentContainer
              );
              setSize(container!, data);
            }
          }
        }
        else if (action === ComponentAction.AssociateItem) {
          if (data.item.content_type === ContentType.Tag) {
            const tag = this.application.findItem(data.item.uuid) as SNTag;
            this.addTag(tag);
          }
        }
        else if (action === ComponentAction.DeassociateItem) {
          const tag = this.application.findItem(data.item.uuid) as SNTag;
          this.removeTag(tag);
        }
        else if (action === ComponentAction.SaveItems) {
          const includesNote = data.items.map((item: RawPayload) => {
            return item.uuid;
          }).includes(this.getState().note.uuid);
          if (includesNote) {
            this.showSavingStatus();
          }
        }
      }
    });
  }

  reloadComponentStackArray() {
    const components = this.application.componentManager!
      .componentsForArea(ComponentArea.EditorStack)
      .sort((a, b) => {
        return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
      });

    this.setState({
      componentStack: components
    });
  }

  reloadComponentContext() {
    this.reloadComponentStackArray();
    if (this.getState().note) {
      for (const component of this.getState().componentStack!) {
        if (component.active) {
          this.application.componentManager!.setComponentHidden(
            component,
            !component.isExplicitlyEnabledForItem(this.getState().note)
          );
        }
      }
    }

    this.application.componentManager!.contextItemDidChangeInArea(ComponentArea.NoteTags);
    this.application.componentManager!.contextItemDidChangeInArea(ComponentArea.EditorStack);
    this.application.componentManager!.contextItemDidChangeInArea(ComponentArea.Editor);
  }

  toggleStackComponentForCurrentItem(component: SNComponent) {
    const hidden = this.application.componentManager!.isComponentHidden(component);
    if (hidden || !component.active) {
      this.application.componentManager!.setComponentHidden(component, false);
      this.associateComponentWithCurrentNote(component);
      if (!component.active) {
        this.application.componentManager!.activateComponent(component);
      }
      this.application.componentManager!.contextItemDidChangeInArea(ComponentArea.EditorStack);
    } else {
      this.application.componentManager!.setComponentHidden(component, true);
      this.disassociateComponentWithCurrentNote(component);
    }
  }

  disassociateComponentWithCurrentNote(component: SNComponent) {
    const note = this.getState().note;
    this.application.changeAndSaveItem(component.uuid, (m) => {
      const mutator = m as ComponentMutator;
      mutator.removeAssociatedItemId(note.uuid);
      mutator.disassociateWithItem(note);
    })
  }

  associateComponentWithCurrentNote(component: SNComponent) {
    const note = this.getState().note;
    this.application.changeAndSaveItem(component.uuid, (m) => {
      const mutator = m as ComponentMutator;
      mutator.removeDisassociatedItemId(note.uuid);
      mutator.associateWithItem(note);
    })
  }

  registerKeyboardShortcuts() {
    this.removeAltKeyObserver = this.application.getKeyboardService().addKeyObserver({
      modifiers: [
        KeyboardModifier.Alt
      ],
      onKeyDown: () => {
        this.setState({
          altKeyDown: true
        });
      },
      onKeyUp: () => {
        this.setState({
          altKeyDown: false
        });
      }
    });

    this.removeTrashKeyObserver = this.application.getKeyboardService().addKeyObserver({
      key: KeyboardKey.Backspace,
      notElementIds: [
        ElementIds.NoteTextEditor,
        ElementIds.NoteTitleEditor
      ],
      modifiers: [KeyboardModifier.Meta],
      onKeyDown: () => {
        this.deleteNote(false);
      },
    });

    this.removeDeleteKeyObserver = this.application.getKeyboardService().addKeyObserver({
      key: KeyboardKey.Backspace,
      modifiers: [
        KeyboardModifier.Meta,
        KeyboardModifier.Shift,
        KeyboardModifier.Alt
      ],
      onKeyDown: (event) => {
        event.preventDefault();
        this.deleteNote(true);
      },
    });
  }

  onSystemEditorLoad() {
    if (this.removeTabObserver) {
      return;
    }
    /**
     * Insert 4 spaces when a tab key is pressed,
     * only used when inside of the text editor.
     * If the shift key is pressed first, this event is
     * not fired.
    */
    const editor = document.getElementById(ElementIds.NoteTextEditor)! as HTMLInputElement;
    this.removeTabObserver = this.application.getKeyboardService().addKeyObserver({
      element: editor,
      key: KeyboardKey.Tab,
      onKeyDown: (event) => {
        if (this.getState().note.locked || event.shiftKey) {
          return;
        }
        event.preventDefault();
        /** Using document.execCommand gives us undo support */
        const insertSuccessful = document.execCommand(
          'insertText',
          false,
          '\t'
        );
        if (!insertSuccessful) {
          /** document.execCommand works great on Chrome/Safari but not Firefox */
          const start = editor.selectionStart!;
          const end = editor.selectionEnd!;
          const spaces = '    ';
          /** Insert 4 spaces */
          editor.value = editor.value.substring(0, start)
            + spaces + editor.value.substring(end);
          /** Place cursor 4 spaces away from where the tab key was pressed */
          editor.selectionStart = editor.selectionEnd = start + 4;
        }
        this.editorValues.text = editor.value;
        this.saveNote(true);
      },
    });

    /**
     * Handles when the editor is destroyed,
     * (and not when our controller is destroyed.)
     */
    angular.element(editor).one('$destroy', () => {
      this.removeTabObserver();
      this.removeTabObserver = undefined;
    });
  }
}

export class EditorPanel extends WebDirective {
  constructor() {
    super();
    this.restrict = 'E';
    this.scope = {
      application: '='
    };
    this.template = template;
    this.replace = true;
    this.controller = EditorCtrl;
    this.controllerAs = 'self';
    this.bindToController = true;
  }
}