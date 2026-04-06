// Uses .js extension import — the TS ESM convention that breaks without proper loader
import WidgetModel from "./widget.model.js";

export default {
  name: "widget",
  displayName: "Widgets",
  toPlugin: () => () => {},
  _model: WidgetModel,
};
