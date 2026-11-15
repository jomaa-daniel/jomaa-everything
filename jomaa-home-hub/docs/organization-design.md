# Device organization design

The `/manage` page uses two titled panes: Devices and Assignments. Devices
opens first; Types and Groups have their own tabs. At narrow widths, opening
a device replaces the inventory with its editor and provides a return button.

## Color and focus

`web/manage.css` defines the colors as semantic CSS variables. The surface and
accent use Nord's dark slate and frost cyan. Muted text and error text use
lighter colors to maintain readable contrast on the dark surface.

- `--ink` is body text; `--muted` is supporting text.
- `--border` frames controls and panes; `--border-quiet` separates rows.
- `--accent` marks focused panes, keys, and controls.
- `--selected` marks the selected row when the inventory does not have focus.
- A focused inventory uses an inverted cyan selection with dark text and a
  selection arrow. Selection persists when focus moves to Assignments.
- `--success`, `--warning`, and `--error` indicate results, accompanied by text
  and a symbol. Category colors accompany category names.

Spacing uses a shared gutter measured in monospace character widths. Square
borders and titles embedded in pane edges distinguish the two regions.
Native selects and checkboxes retain their browser and keyboard behavior.

## Keyboard feedback

The footer stays visible and shows commands for the focused control. It
changes between tabs, search, device selection, categories, group checkboxes,
and rename inputs. Save results share the footer with those commands.

## References

The page adapts terminal design ideas to HTML controls and responsive CSS:

- [Monospace Design TUI](https://github.com/coreyt/monospace-design-tui): focused
  surfaces, persistent command bars, and visible selection.
- [Awesome TUI Design](https://github.com/cola-runner/awesome-tui-design): the
  Nord palette and Lazygit's pane borders and inverted selection.
- [Pageton TUI Design Skill](https://github.com/pageton/tui-design-skill):
  spacing, master-detail layout, and restraint in color and emphasis.
- [Diego Marino TUI Design](https://github.com/diegomarino/tui-design): semantic
  color roles, contrast measurements, and checking rendered layouts at several
  sizes. Its terminal cell-grid audit is not a browser compliance test.
