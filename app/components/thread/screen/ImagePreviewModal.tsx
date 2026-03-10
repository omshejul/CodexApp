import { Image, Modal, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

interface ImagePreviewModalProps {
  previewImageUri: string | null;
  insetsTop: number;
  insetsBottom: number;
  onClose: () => void;
}

export function ImagePreviewModal({
  previewImageUri,
  insetsTop,
  insetsBottom,
  onClose,
}: ImagePreviewModalProps) {
  return (
    <Modal transparent visible={previewImageUri !== null} animationType="fade" onRequestClose={onClose}>
      <Pressable
        className="flex-1 bg-black/95 px-4"
        style={{
          paddingTop: Math.max(insetsTop, 8) + 8,
          paddingBottom: Math.max(insetsBottom, 8) + 8,
        }}
        onPress={onClose}
      >
        <View className="mb-3 flex-row justify-end">
          <View className="rounded-full bg-white/10 p-2">
            <Ionicons name="close" size={20} color="#ffffff" />
          </View>
        </View>
        <Pressable
          className="flex-1 items-center justify-center"
          onPress={(event) => {
            event.stopPropagation();
          }}
        >
          {previewImageUri ? <Image source={{ uri: previewImageUri }} resizeMode="contain" className="h-full w-full" /> : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
