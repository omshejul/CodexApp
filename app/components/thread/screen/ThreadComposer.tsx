import { type RefObject } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { AnimatePresence, MotiView } from "moti";
import { Ionicons } from "@expo/vector-icons";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { type QueuedThreadMessage } from "@/lib/api";
import { ResponseStatusTrack } from "@/components/thread/screen/ResponseStatusTrack";
import {
  type CollaborationMode,
  type ComposerSelection,
  type ModelOption,
  type PendingImage,
  type PendingRequestUserInput,
  type ReasoningEffort,
  type ReasoningOption,
} from "@/components/thread/screen/types";
import { queuedMessageSummary } from "@/components/thread/screen/helpers";

interface ThreadComposerProps {
  activeRequestUserInput: PendingRequestUserInput | null;
  pendingRequestUserInputs: PendingRequestUserInput[];
  activeRequestExpiryLabel: string | null;
  activeRequestQuestion: PendingRequestUserInput["questions"][number] | null;
  activeRequestSelections: Record<string, string[]>;
  activeRequestText: Record<string, string>;
  activeRequestQuestionIndex: number;
  activeRequestError: string | null | undefined;
  activeRequestSubmitting: boolean;
  onToggleRequestQuestionOption: (requestId: string, questionId: string, optionLabel: string) => void;
  onSetRequestQuestionText: (requestId: string, questionId: string, value: string) => void;
  onBackRequestQuestion: () => void;
  onAdvanceRequestQuestion: () => void;
  onSubmitRequestUserInput: (request: PendingRequestUserInput) => void;
  queuedMessages: QueuedThreadMessage[];
  queueActionPendingIds: Set<string>;
  queueErrorsById: Record<string, string>;
  sending: boolean;
  onSteerQueuedMessage: (messageId: string) => void;
  onRemoveQueuedMessage: (messageId: string) => void;
  optionsLoaded: boolean;
  resolvedSelectedModel: string | null;
  currentReasoningOptions: ReasoningOption[];
  modelOptions: ModelOption[];
  resolvedSelectedReasoning: ReasoningEffort | null;
  selectedCollaborationMode: CollaborationMode;
  keyboardVisible: boolean;
  onOpenModelDropdown: () => void;
  onOpenReasoningDropdown: () => void;
  onToggleCollaborationMode: () => void;
  onDismissKeyboard: () => void;
  showMentionSuggestions: boolean;
  mentionLoading: boolean;
  mentionError: string | null;
  mentionSuggestions: string[];
  onApplyMentionSelection: (filePath: string) => void;
  pendingImages: PendingImage[];
  onPreviewPendingImage: (uri: string) => void;
  onRemovePendingImage: (imageId: string) => void;
  onPickImages: () => void;
  composerInputRef: RefObject<TextInput | null>;
  composerText: string;
  onComposerTextChange: (value: string) => void;
  composerSelection: ComposerSelection;
  onComposerSelectionChange: (selection: ComposerSelection) => void;
  composerActionDisabled: boolean;
  shouldShowStopAction: boolean;
  responseStatusText: string | null;
  onStopResponse: () => void;
  onSend: () => void;
  composerActionIconName: "time-outline" | "stop-circle-outline" | "arrow-up";
  stopping: boolean;
  insetsBottom: number;
}

export function ThreadComposer({
  activeRequestUserInput,
  pendingRequestUserInputs,
  activeRequestExpiryLabel,
  activeRequestQuestion,
  activeRequestSelections,
  activeRequestText,
  activeRequestQuestionIndex,
  activeRequestError,
  activeRequestSubmitting,
  onToggleRequestQuestionOption,
  onSetRequestQuestionText,
  onBackRequestQuestion,
  onAdvanceRequestQuestion,
  onSubmitRequestUserInput,
  queuedMessages,
  queueActionPendingIds,
  queueErrorsById,
  sending,
  onSteerQueuedMessage,
  onRemoveQueuedMessage,
  optionsLoaded,
  resolvedSelectedModel,
  currentReasoningOptions,
  modelOptions,
  resolvedSelectedReasoning,
  selectedCollaborationMode,
  keyboardVisible,
  onOpenModelDropdown,
  onOpenReasoningDropdown,
  onToggleCollaborationMode,
  onDismissKeyboard,
  showMentionSuggestions,
  mentionLoading,
  mentionError,
  mentionSuggestions,
  onApplyMentionSelection,
  pendingImages,
  onPreviewPendingImage,
  onRemovePendingImage,
  onPickImages,
  composerInputRef,
  composerText,
  onComposerTextChange,
  composerSelection,
  onComposerSelectionChange,
  composerActionDisabled,
  shouldShowStopAction,
  responseStatusText,
  onStopResponse,
  onSend,
  composerActionIconName,
  stopping,
  insetsBottom,
}: ThreadComposerProps) {
  const composerContent = (
    <>
      {activeRequestUserInput ? (
        <View className="mb-2 rounded-2xl border border-border/40 bg-card px-3 py-3">
          <View className="mb-2 flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Ionicons name="help-circle-outline" size={16} color="#e5e7eb" />
              <Text className="text-sm font-semibold text-foreground">Input required</Text>
            </View>
            <Text className="text-[11px] text-muted-foreground">
              {pendingRequestUserInputs.length > 1
                ? `1/${pendingRequestUserInputs.length} pending`
                : activeRequestExpiryLabel
                ? `Expires ${activeRequestExpiryLabel}`
                : "Pending"}
            </Text>
          </View>

          {activeRequestQuestion ? (
            (() => {
              const question = activeRequestQuestion;
              const selectedAnswers = activeRequestSelections[question.id] ?? [];
              const textValue = activeRequestText[question.id] ?? "";
              const hasOptions = Array.isArray(question.options) && question.options.length > 0;
              const isLastQuestion = activeRequestQuestionIndex === activeRequestUserInput.questions.length - 1;

              return (
                <View key={`${activeRequestUserInput.id}-${question.id}`}>
                  <Text className="text-[11px] text-muted-foreground">
                    Question {activeRequestQuestionIndex + 1}/{activeRequestUserInput.questions.length}
                  </Text>
                  <Text className="mt-1 text-xs font-semibold uppercase tracking-[0.7px] text-muted-foreground">
                    {question.header}
                  </Text>
                  <Text className="mt-1 text-sm text-foreground">{question.question}</Text>

                  {hasOptions ? (
                    <View className="mt-2 gap-2">
                      {question.options?.map((option) => {
                        const selected = selectedAnswers.includes(option.label);
                        return (
                          <Pressable
                            key={`${activeRequestUserInput.id}-${question.id}-${option.label}`}
                            onPress={() => onToggleRequestQuestionOption(activeRequestUserInput.id, question.id, option.label)}
                            className={`rounded-xl border px-3 py-2 ${
                              selected ? "border-border bg-muted" : "border-border/40 bg-black/20"
                            }`}
                          >
                            <View className="flex-row items-start gap-2">
                              <Ionicons
                                name={selected ? "checkmark-circle" : "ellipse-outline"}
                                size={18}
                                color={selected ? "#e5e7eb" : "#9ca3af"}
                              />
                              <View className="flex-1">
                                <Text className="text-sm font-semibold text-foreground">{option.label}</Text>
                                {option.description ? (
                                  <Text className="mt-0.5 text-xs leading-4 text-muted-foreground">{option.description}</Text>
                                ) : null}
                              </View>
                            </View>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}

                  {!hasOptions || question.isOther ? (
                    <TextInput
                      value={textValue}
                      onChangeText={(value) => onSetRequestQuestionText(activeRequestUserInput.id, question.id, value)}
                      placeholder={hasOptions ? "Other" : "Type your answer"}
                      placeholderTextColor="#6b7280"
                      secureTextEntry={question.isSecret}
                      multiline={!question.isSecret}
                      className="mt-2 rounded-xl border border-border/40 bg-black/20 px-3 py-2 text-sm text-foreground"
                    />
                  ) : null}

                  {activeRequestError ? <Text className="mt-2 text-xs text-red-300">{activeRequestError}</Text> : null}

                  <View className="mt-3 flex-row items-center justify-between gap-2">
                    <Pressable
                      onPress={onBackRequestQuestion}
                      disabled={activeRequestQuestionIndex === 0 || activeRequestSubmitting}
                      className={`h-10 flex-1 items-center justify-center rounded-xl border ${
                        activeRequestQuestionIndex === 0 || activeRequestSubmitting
                          ? "border-border/20 bg-muted/30"
                          : "border-border/40 bg-black/20"
                      }`}
                    >
                      <Text className="text-sm font-semibold text-foreground">Back</Text>
                    </Pressable>

                    <Pressable
                      disabled={activeRequestSubmitting}
                      onPress={isLastQuestion ? () => onSubmitRequestUserInput(activeRequestUserInput) : onAdvanceRequestQuestion}
                      className={`h-10 flex-1 items-center justify-center rounded-xl ${
                        activeRequestSubmitting ? "bg-muted" : "bg-foreground"
                      }`}
                    >
                      <Text className={`text-sm font-semibold ${activeRequestSubmitting ? "text-muted-foreground" : "text-background"}`}>
                        {activeRequestSubmitting ? "Submitting..." : isLastQuestion ? "Submit input" : "Next"}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              );
            })()
          ) : null}
        </View>
      ) : null}

      {queuedMessages.length > 0 ? (
        <View className="mb-2 rounded-2xl border border-border/30 bg-card px-3 py-3">
          <View className="mb-2 flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
              <Ionicons name="layers-outline" size={16} color="#e5e7eb" />
              <Text className="text-sm font-semibold text-foreground">Queued messages</Text>
            </View>
            <Text className="text-[11px] text-muted-foreground">{queuedMessages.length} pending</Text>
          </View>
          <View className="max-h-52">
            <ScrollView nestedScrollEnabled showsVerticalScrollIndicator keyboardShouldPersistTaps="handled">
              {queuedMessages.map((message, index) => {
                const summary = queuedMessageSummary(message.request);
                const isActionPending = queueActionPendingIds.has(message.id);
                const imageLabel =
                  summary.imageCount > 0
                    ? `${summary.imageCount} image${summary.imageCount === 1 ? "" : "s"}`
                    : null;
                const previewText =
                  summary.text.length > 0
                    ? summary.text
                    : imageLabel
                    ? `Attachment only (${imageLabel})`
                    : "Queued message";

                return (
                  <View
                    key={message.id}
                    className={`rounded-xl border border-border/30 bg-black/20 px-3 py-2 ${index > 0 ? "mt-2" : ""}`}
                  >
                    <Text className="text-sm text-foreground" numberOfLines={3}>
                      {previewText}
                    </Text>
                    {imageLabel && summary.text.length > 0 ? (
                      <Text className="mt-1 text-xs text-muted-foreground">{imageLabel}</Text>
                    ) : null}
                    {queueErrorsById[message.id] ? (
                      <Text className="mt-1 text-xs text-red-300">{queueErrorsById[message.id]}</Text>
                    ) : null}
                    <View className="mt-2 flex-row gap-2">
                      <Pressable
                        onPress={() => {
                          onSteerQueuedMessage(message.id);
                        }}
                        disabled={isActionPending || sending}
                        className={`h-9 flex-1 items-center justify-center rounded-lg ${
                          isActionPending || sending ? "bg-muted" : "bg-foreground"
                        }`}
                      >
                        <Text
                          className={`text-xs font-semibold ${
                            isActionPending || sending ? "text-muted-foreground" : "text-background"
                          }`}
                        >
                          {isActionPending ? "Working..." : "Steer now"}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          onRemoveQueuedMessage(message.id);
                        }}
                        disabled={isActionPending}
                        className={`h-9 flex-1 items-center justify-center rounded-lg border ${
                          isActionPending ? "border-border/20 bg-muted/30" : "border-border/40 bg-black/20"
                        }`}
                      >
                        <Text className="text-xs font-semibold text-foreground">Remove</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        </View>
      ) : null}

      {optionsLoaded && resolvedSelectedModel && currentReasoningOptions.length > 0 ? (
        <View className="mb-1.5 flex-row justify-between gap-2">
          <View className="flex-row gap-2">
            <Pressable
              onPress={onOpenModelDropdown}
              className="h-9 flex gap-2 flex-row items-center justify-between rounded-full px-3"
            >
              <Text className="text-sm font-semibold text-foreground">
                {modelOptions.find((option) => option.value === resolvedSelectedModel)?.label}
              </Text>
              <View className="w-4 items-center justify-center">
                <Ionicons name="chevron-up" size={14} className="text-foreground" />
              </View>
            </Pressable>
            <Pressable
              onPress={onOpenReasoningDropdown}
              className="h-9 flex gap-2 flex-row items-center justify-between rounded-full px-3"
            >
              <Text className="text-sm font-semibold text-foreground">
                {currentReasoningOptions.find((option) => option.value === resolvedSelectedReasoning)?.label}
              </Text>
              <View className="w-4 items-center justify-center">
                <Ionicons name="chevron-up" size={14} className="text-foreground" />
              </View>
            </Pressable>
            <Pressable onPress={onToggleCollaborationMode} className="h-9 w-9 items-center justify-center rounded-full">
              <FontAwesome6
                name="list-check"
                size={16}
                color={selectedCollaborationMode === "plan" ? "#3b82f6" : "#64748b"}
              />
            </Pressable>
          </View>
          {keyboardVisible ? (
            <MotiView
              from={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ type: "timing", duration: 150 }}
            >
              <Pressable
                onPress={onDismissKeyboard}
                className="h-9 flex-row items-center justify-center gap-1.5 rounded-full border border-border/10 bg-muted px-3"
              >
                <Ionicons name="keypad" size={16} color="#e0e0e0" />
                <Ionicons name="chevron-down" className="pt-0.5" size={14} color="#e0e0e0" />
              </Pressable>
            </MotiView>
          ) : null}
        </View>
      ) : null}

      {showMentionSuggestions ? (
        <View className="mb-2 max-h-56 overflow-hidden rounded-2xl border border-border/10 bg-muted">
          <View className="flex-row items-center gap-1.5 border-b border-border/10 px-3 py-1.5">
            <Ionicons name="at" size={13} color="#94a3b8" />
            <Text className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Files</Text>
            {mentionLoading ? <ActivityIndicator size="small" color="#94a3b8" className="ml-auto" /> : null}
          </View>
          {mentionError ? (
            <View className="flex-row items-center gap-2 px-3 py-2.5">
              <Ionicons name="warning-outline" size={14} color="#fbbf24" />
              <Text className="text-xs text-amber-300">{mentionError}</Text>
            </View>
          ) : null}
          {mentionLoading && mentionSuggestions.length === 0 ? (
            <View className="px-3 py-3">
              <Text className="text-xs text-muted-foreground">Searching files…</Text>
            </View>
          ) : null}
          {!mentionLoading && !mentionError && mentionSuggestions.length === 0 ? (
            <View className="flex-row items-center gap-2 px-3 py-3">
              <Ionicons name="document-outline" size={14} color="#64748b" />
              <Text className="text-xs text-muted-foreground">No matching files</Text>
            </View>
          ) : null}
          <ScrollView
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
            className="max-h-44"
          >
            {mentionSuggestions.map((filePath) => {
              const parts = filePath.split("/");
              const fileName = parts.pop() ?? filePath;
              const dirPath = parts.join("/");
              return (
                <Pressable
                  key={`mention-${filePath}`}
                  onPress={() => onApplyMentionSelection(filePath)}
                  className="flex-row items-center gap-2.5 border-b border-border/5 px-3 py-2 active:bg-white/5"
                >
                  <Ionicons name="document-text-outline" size={16} color="#94a3b8" />
                  <View className="flex-1">
                    <Text className="font-mono text-[13px] font-semibold text-foreground" numberOfLines={1}>
                      {fileName}
                    </Text>
                    {dirPath ? (
                      <Text className="font-mono text-[11px] text-muted-foreground" numberOfLines={1}>
                        {dirPath}
                      </Text>
                    ) : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}

      {pendingImages.length > 0 ? (
        <View className="mb-2">
          <FlatList
            horizontal
            data={pendingImages}
            keyExtractor={(item) => item.id}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <View className="mr-2">
                <Pressable onPress={() => onPreviewPendingImage(item.uri)}>
                  <Image source={{ uri: item.uri }} resizeMode="cover" className="h-16 w-16 rounded-lg bg-black/25" />
                </Pressable>
                <Pressable
                  onPress={() => onRemovePendingImage(item.id)}
                  className="absolute -right-1 -top-1 rounded-full bg-black/70 p-1"
                >
                  <Ionicons name="close" size={12} color="#ffffff" />
                </Pressable>
              </View>
            )}
          />
        </View>
      ) : null}

      <View className="flex-row items-end gap-2">
        <Pressable onPress={onPickImages} className="h-11 w-11 items-center justify-center rounded-full border border-border/10 bg-muted">
          <Ionicons name="image-outline" size={18} className="text-primary-foreground" />
        </Pressable>
        <TextInput
          ref={composerInputRef}
          value={composerText}
          onChangeText={onComposerTextChange}
          onSelectionChange={(event) => onComposerSelectionChange(event.nativeEvent.selection)}
          selection={composerSelection}
          placeholder="Continue this thread..."
          placeholderTextColor="#94a3b8"
          keyboardAppearance="dark"
          multiline
          className="max-h-36 flex-1 rounded-3xl border border-border/10 bg-muted px-4 py-3 text-foreground"
        />
        <Pressable
          disabled={composerActionDisabled}
          onPress={shouldShowStopAction ? onStopResponse : onSend}
          className={`h-11 w-11 items-center justify-center rounded-full ${
            composerActionDisabled ? "bg-secondary" : "bg-primary"
          }`}
        >
          <AnimatePresence>
            <MotiView
              key={`${composerActionIconName}-${shouldShowStopAction ? "stop" : "send"}-${stopping ? "stopping" : "active"}`}
              from={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: "timing", duration: 140 }}
              style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center" }}
            >
              <Ionicons name={composerActionIconName} size={20} className="text-primary-foreground" />
            </MotiView>
          </AnimatePresence>
        </Pressable>
      </View>
    </>
  );

  return Platform.OS === "android" ? (
    <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
      <View>
        {responseStatusText ? (
          <View className="-mx-4 border-t border-border/50 bg-background px-4 py-2">
            <ResponseStatusTrack label={responseStatusText} />
          </View>
        ) : null}
        <View className="-mx-4 border-t border-border/50 bg-background px-4 pt-2" style={{ paddingBottom: Math.max(insetsBottom, 8) }}>
          {composerContent}
        </View>
      </View>
    </KeyboardStickyView>
  ) : (
    <View>
      {responseStatusText ? (
        <View className="-mx-4 border-t border-border/50 bg-background px-4 py-2">
          <ResponseStatusTrack label={responseStatusText} />
        </View>
      ) : null}
      <View
        className="-mx-4 border-t border-border/50 bg-background px-4 pt-2"
        style={{ paddingBottom: keyboardVisible ? 10 : Math.max(insetsBottom, 8) }}
      >
        {composerContent}
      </View>
    </View>
  );
}
