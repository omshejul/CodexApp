import { View } from "react-native";
import { MotiText } from "moti";

interface ResponseStatusTrackProps {
  label: string;
}

export function ResponseStatusTrack({ label }: ResponseStatusTrackProps) {
  return (
    <View className="px-1">
      <MotiText
        from={{
          opacity: 0.58,
        }}
        animate={{
          opacity: 1,
        }}
        transition={{ type: "timing", duration: 900, loop: true, repeatReverse: true }}
        className="px-1.5 py-1 text-xs font-medium text-muted-foreground"
      >
        {label}
      </MotiText>
    </View>
  );
}
